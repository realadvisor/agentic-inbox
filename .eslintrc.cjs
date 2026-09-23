module.exports = {
	root: true,
	parser: require.resolve("@typescript-eslint/parser"),
	parserOptions: {
		ecmaVersion: "latest",
		sourceType: "module",
		ecmaFeatures: { jsx: true },
	},
	env: { browser: true, node: true, es2022: true },
	extends: ["eslint:recommended"],
	ignorePatterns: [
		"node_modules/",
		"build/",
		".local/",
		".react-router/",
		".wrangler/",
	],
	overrides: [
		{
			files: ["**/*.ts", "**/*.tsx"],
			rules: { "no-undef": "off", "no-unused-vars": "off" },
		},
	],
};
