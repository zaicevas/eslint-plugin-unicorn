'use strict';
const {
	isParenthesized,
	isArrowToken,
	isCommaToken,
	isSemicolonToken,
	isClosingParenToken,
	findVariable,
} = require('eslint-utils');
const indentString = require('indent-string');
const {methodCallSelector, referenceIdentifierSelector} = require('./selectors/index.js');
const {extendFixRange} = require('./fix/index.js');
const needsSemicolon = require('./utils/needs-semicolon.js');
const shouldAddParenthesesToExpressionStatementExpression = require('./utils/should-add-parentheses-to-expression-statement-expression.js');
const {getParentheses} = require('./utils/parentheses.js');
const isFunctionSelfUsedInside = require('./utils/is-function-self-used-inside.js');
const {isNodeMatches} = require('./utils/is-node-matches.js');
const assertToken = require('./utils/assert-token.js');
const {fixSpaceAroundKeyword} = require('./fix/index.js');
const getIndentString = require('./utils/get-indent-string.js');

const MESSAGE_ID = 'no-array-for-each';
const messages = {
	[MESSAGE_ID]: 'Use `for…of` instead of `Array#forEach(…)`.',
};

const arrayForEachCallSelector = methodCallSelector({
	method: 'forEach',
	includeOptionalCall: true,
	includeOptionalMember: true,
});

const continueAbleNodeTypes = new Set([
	'WhileStatement',
	'DoWhileStatement',
	'ForStatement',
	'ForOfStatement',
	'ForInStatement',
]);

function isReturnStatementInContinueAbleNodes(returnStatement, callbackFunction) {
	for (let node = returnStatement; node && node !== callbackFunction; node = node.parent) {
		if (continueAbleNodeTypes.has(node.type)) {
			return true;
		}
	}

	return false;
}

function shouldSwitchReturnStatementToBlockStatement(returnStatement) {
	const {parent} = returnStatement;

	switch (parent.type) {
		case 'IfStatement':
			return parent.consequent === returnStatement || parent.alternate === returnStatement;

		// These parent's body need switch to `BlockStatement` too, but since they are "continueAble", won't fix
		// case 'ForStatement':
		// case 'ForInStatement':
		// case 'ForOfStatement':
		// case 'WhileStatement':
		// case 'DoWhileStatement':
		case 'WithStatement':
			return parent.body === returnStatement;

		default:
			return false;
	}
}

function getFixFunction(callExpression, functionInfo, context) {
	const sourceCode = context.getSourceCode();
	const [callback] = callExpression.arguments;
	const parameters = callback.params;
	const array = callExpression.callee.object;
	const {returnStatements} = functionInfo.get(callback);
	const isOptionalChaining = callExpression.callee.optional;
	const isBlockStatement = callback.body.type === 'BlockStatement';
	const indentedString = getIndentString(callExpression.parent.parent, sourceCode);

	const getForOfLoopHeadText = () => {
		const [elementText, indexText] = parameters.map(parameter => sourceCode.getText(parameter));
		const useEntries = parameters.length === 2;

		let text = 'for (';
		text += isFunctionParameterVariableReassigned(callback, context) ? 'let' : 'const';
		text += ' ';
		text += useEntries ? `[${indexText}, ${elementText}]` : elementText;
		text += ' of ';

		let arrayText = sourceCode.getText(array);
		if (isParenthesized(array, sourceCode)) {
			arrayText = `(${arrayText})`;
		}

		text += arrayText;

		if (useEntries) {
			text += '.entries()';
		}

		text += ') ';

		return text;
	};

	const getForOfLoopHeadRange = () => {
		const [start] = callExpression.range;
		let end;
		if (callback.body.type === 'BlockStatement') {
			end = callback.body.range[0];
		} else {
			// In this case, parentheses are not included in body location, so we look for `=>` token
			// foo.forEach(bar => ({bar}))
			//                     ^
			const arrowToken = sourceCode.getTokenBefore(callback.body, isArrowToken);
			end = arrowToken.range[1];
		}

		return [start, end];
	};

	function * replaceReturnStatement(returnStatement, fixer) {
		const returnToken = sourceCode.getFirstToken(returnStatement);
		assertToken(returnToken, {
			expected: 'return',
			ruleId: 'no-array-for-each',
		});

		if (!returnStatement.argument) {
			yield fixer.replaceText(returnToken, 'continue');
			return;
		}

		// Remove `return`
		yield fixer.remove(returnToken);

		const previousToken = sourceCode.getTokenBefore(returnToken);
		const nextToken = sourceCode.getTokenAfter(returnToken);
		let textBefore = '';
		let textAfter = '';
		const shouldAddParentheses
			= !isParenthesized(returnStatement.argument, sourceCode)
				&& shouldAddParenthesesToExpressionStatementExpression(returnStatement.argument);
		if (shouldAddParentheses) {
			textBefore = `(${textBefore}`;
			textAfter = `${textAfter})`;
		}

		const insertBraces = shouldSwitchReturnStatementToBlockStatement(returnStatement);
		if (insertBraces) {
			textBefore = `{ ${textBefore}`;
		} else if (needsSemicolon(previousToken, sourceCode, shouldAddParentheses ? '(' : nextToken.value)) {
			textBefore = `;${textBefore}`;
		}

		if (textBefore) {
			yield fixer.insertTextBefore(nextToken, textBefore);
		}

		if (textAfter) {
			yield fixer.insertTextAfter(returnStatement.argument, textAfter);
		}

		const returnStatementHasSemicolon = isSemicolonToken(sourceCode.getLastToken(returnStatement));
		if (!returnStatementHasSemicolon) {
			yield fixer.insertTextAfter(returnStatement, ';');
		}

		yield fixer.insertTextAfter(returnStatement, ' continue;');

		if (insertBraces) {
			yield fixer.insertTextAfter(returnStatement, ' }');
		}
	}

	const shouldRemoveExpressionStatementLastToken = token => {
		if (!isSemicolonToken(token)) {
			return false;
		}

		if (callback.body.type !== 'BlockStatement' && !isOptionalChaining) {
			return false;
		}

		return true;
	};

	function * wrapInIfStatement(fixer) {
		const isSingleLine = !isBlockStatement || callback.body.loc.start.line === callback.body.loc.end.line;

		yield fixer.insertTextBefore(callExpression, `if (${callExpression.callee.object.name}) {\n`);
		yield fixer.insertTextAfter(callExpression, `\n${indentedString}}`);

		const indentedForOfClosingBracket = isSingleLine ? '}' : `${indentString('}', 1, {indent: '\t'})}`;
		const isMultilineBlock = callback.body.type === 'BlockStatement' && !isSingleLine;

		if (callback.body.type !== 'BlockStatement' && isSingleLine) {
			yield fixer.insertTextAfter(callback.body, ';')
		}

		if (!isMultilineBlock) {
			return;
		}

		yield fixer.replaceText(sourceCode.getLastToken(callback.body), indentedForOfClosingBracket);

		const expressions = callback.body.body;

		for (const expression of expressions) {
			yield fixer.replaceText(expression, indentString(sourceCode.getText(expression), 1, {indent: '\t'}));
		}
	}

	function * removeCallbackParentheses(fixer) {
		// Opening parenthesis tokens already included in `getForOfLoopHeadRange`
		const closingParenthesisTokens = getParentheses(callback, sourceCode)
			.filter(token => isClosingParenToken(token));

		for (const closingParenthesisToken of closingParenthesisTokens) {
			yield fixer.remove(closingParenthesisToken);
		}
	}

	return function * (fixer) {
		const trimTrailingWhitespace = text => text.replace(/\s+$/, '');
		const indentedForOfLoopHeadText = `${indentedString}${indentString(getForOfLoopHeadText(), 1, {indent: '\t'})}`;
		const trimmedForOfLoopHeadText = isBlockStatement ? indentedForOfLoopHeadText : trimTrailingWhitespace(indentedForOfLoopHeadText);

		// Replace these with `for (const … of …) `
		// foo.forEach(bar =>    bar)
		// ^^^^^^^^^^^^^^^^^^ (space after `=>` didn't included)
		// foo.forEach(bar =>    {})
		// ^^^^^^^^^^^^^^^^^^^^^^
		// foo.forEach(function(bar)    {})
		// ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
		yield fixer.replaceTextRange(getForOfLoopHeadRange(), isOptionalChaining ? trimmedForOfLoopHeadText : getForOfLoopHeadText());

		// Parenthesized callback function
		// foo.forEach( ((bar => {})) )
		//                         ^^
		yield * removeCallbackParentheses(fixer);

		const [
			penultimateToken,
			lastToken,
		] = sourceCode.getLastTokens(callExpression, 2);

		// The possible trailing comma token of `Array#forEach()` CallExpression
		// foo.forEach(bar => {},)
		//                      ^
		if (isCommaToken(penultimateToken)) {
			yield fixer.remove(penultimateToken);
		}

		// The closing parenthesis token of `Array#forEach()` CallExpression
		// foo.forEach(bar => {})
		//                      ^
		yield fixer.remove(lastToken);

		for (const returnStatement of returnStatements) {
			yield * replaceReturnStatement(returnStatement, fixer);
		}

		const expressionStatementLastToken = sourceCode.getLastToken(isOptionalChaining ? callExpression.parent.parent : callExpression.parent);
		// Remove semicolon if it's not needed anymore
		// foo.forEach(bar => {});
		//                       ^
		if (shouldRemoveExpressionStatementLastToken(expressionStatementLastToken)) {
			yield fixer.remove(expressionStatementLastToken, fixer);
		}

		yield * fixSpaceAroundKeyword(fixer, callExpression.parent, sourceCode);

		if (isOptionalChaining) {
			yield * wrapInIfStatement(fixer);
		}

		// Prevent possible variable conflicts
		yield * extendFixRange(fixer, callExpression.parent.range);
	};
}

const isChildScope = (child, parent) => {
	for (let scope = child; scope; scope = scope.upper) {
		if (scope === parent) {
			return true;
		}
	}

	return false;
};

function isFunctionParametersSafeToFix(callbackFunction, {context, scope, array, allIdentifiers}) {
	const variables = context.getDeclaredVariables(callbackFunction);

	for (const variable of variables) {
		if (variable.defs.length !== 1) {
			return false;
		}

		const [definition] = variable.defs;
		if (definition.type !== 'Parameter') {
			continue;
		}

		const variableName = definition.name.name;
		const [arrayStart, arrayEnd] = array.range;
		for (const identifier of allIdentifiers) {
			const {name, range: [start, end]} = identifier;
			if (
				name !== variableName
				|| start < arrayStart
				|| end > arrayEnd
			) {
				continue;
			}

			const variable = findVariable(scope, identifier);
			if (!variable || variable.scope === scope || isChildScope(scope, variable.scope)) {
				return false;
			}
		}
	}

	return true;
}

function isFunctionParameterVariableReassigned(callbackFunction, context) {
	return context.getDeclaredVariables(callbackFunction)
		.filter(variable => variable.defs[0].type === 'Parameter')
		.some(variable => {
			const {references} = variable;
			return references.some(reference => {
				const node = reference.identifier;
				const {parent} = node;
				return parent.type === 'UpdateExpression'
					|| (parent.type === 'AssignmentExpression' && parent.left === node);
			});
		});
}

function isFixable(callExpression, {scope, functionInfo, allIdentifiers, context}) {
	const sourceCode = context.getSourceCode();
	// Check `CallExpression`
	if (
		callExpression.optional
		|| isParenthesized(callExpression, sourceCode)
		|| callExpression.arguments.length !== 1
	) {
		return false;
	}

	// Check `CallExpression.parent`
	if (callExpression.parent.type !== 'ExpressionStatement' && callExpression.parent.type !== 'ChainExpression') {
		return false;
	}

	// Check `CallExpression.arguments[0]`;
	const [callback] = callExpression.arguments;
	if (
		// Leave non-function type to `no-array-callback-reference` rule
		(callback.type !== 'FunctionExpression' && callback.type !== 'ArrowFunctionExpression')
		|| callback.async
		|| callback.generator
	) {
		return false;
	}

	// Check `callback.params`
	const parameters = callback.params;
	if (
		!(parameters.length === 1 || parameters.length === 2)
		|| parameters.some(({type, typeAnnotation}) => type === 'RestElement' || typeAnnotation)
		|| !isFunctionParametersSafeToFix(callback, {scope, array: callExpression, allIdentifiers, context})
	) {
		return false;
	}

	// Check `ReturnStatement`s in `callback`
	const {returnStatements, scope: callbackScope} = functionInfo.get(callback);
	if (returnStatements.some(returnStatement => isReturnStatementInContinueAbleNodes(returnStatement, callback))) {
		return false;
	}

	if (isFunctionSelfUsedInside(callback, callbackScope)) {
		return false;
	}

	return true;
}

const ignoredObjects = [
	'React.Children',
	'Children',
	'R',
	// https://www.npmjs.com/package/p-iteration
	'pIteration',
];

/** @param {import('eslint').Rule.RuleContext} context */
const create = context => {
	const functionStack = [];
	const callExpressions = [];
	const allIdentifiers = [];
	const functionInfo = new Map();

	return {
		':function'(node) {
			functionStack.push(node);
			functionInfo.set(node, {
				returnStatements: [],
				scope: context.getScope(),
			});
		},
		':function:exit'() {
			functionStack.pop();
		},
		[referenceIdentifierSelector()](node) {
			allIdentifiers.push(node);
		},
		':function ReturnStatement'(node) {
			const currentFunction = functionStack[functionStack.length - 1];
			const {returnStatements} = functionInfo.get(currentFunction);
			returnStatements.push(node);
		},
		[arrayForEachCallSelector](node) {
			if (isNodeMatches(node.callee.object, ignoredObjects)) {
				return;
			}

			callExpressions.push({
				node,
				scope: context.getScope(),
			});
		},
		* 'Program:exit'() {
			for (const {node, scope} of callExpressions) {
				const problem = {
					node: node.callee.property,
					messageId: MESSAGE_ID,
				};

				if (isFixable(node, {scope, allIdentifiers, functionInfo, context})) {
					problem.fix = getFixFunction(node, functionInfo, context);
				}

				yield problem;
			}
		},
	};
};

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
	create,
	meta: {
		type: 'suggestion',
		docs: {
			description: 'Prefer `for…of` over `Array#forEach(…)`.',
		},
		fixable: 'code',
		messages,
	},
};
