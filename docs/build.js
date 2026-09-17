// Wraps page.fragment.html (artifact form: no html/head/body) into a full document for GitHub Pages.
const fs = require("fs"), path = require("path");
const frag = fs.readFileSync(path.join(__dirname, "page.fragment.html"), "utf8");
const headEnd = frag.indexOf("</style>") + "</style>".length;
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
${frag.slice(0, headEnd)}
</head>
<body>
${frag.slice(headEnd)}
</body>
</html>
`;
fs.writeFileSync(path.join(__dirname, "index.html"), html);
console.log("docs/index.html written", html.length, "bytes");
