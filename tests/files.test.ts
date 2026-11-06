import { test } from "node:test";
import assert from "node:assert/strict";
import { countLines, decodeText, fileBlock, languageOf, withFiles } from "../shared/files";

test("files become fenced blocks that their own backticks can't close", () => {
  assert.equal(fileBlock("app.py", "print(1)\n"), "File: app.py\n```python\nprint(1)\n```");
  const tricky = "Use ```js fences``` and ````four```` too";
  const block = fileBlock("notes.md", tricky);
  assert.ok(block.startsWith("File: notes.md\n`````markdown\n"), "the fence is longer than any run inside");
  assert.ok(block.endsWith("\n`````"));
  assert.equal(fileBlock("Makefile", "all:"), "File: Makefile\n```makefile\nall:\n```");
  assert.equal(languageOf("archive.unknownext"), "");
  assert.equal(languageOf("src/App.TSX"), "tsx");
  assert.equal(fileBlock("evil\nname.txt", "x").split("\n")[0], "File: evil name.txt", "a name can't add lines");
});

test("a prompt lists its files before the prompt text", () => {
  assert.equal(withFiles("Explain", [{ name: "a.js", text: "1" }, { name: "b.css", text: "2" }]),
    "File: a.js\n```javascript\n1\n```\n\nFile: b.css\n```css\n2\n```\n\nExplain");
  assert.equal(withFiles("", [{ name: "a.txt", text: "only" }]), "File: a.txt\n```\nonly\n```");
});

test("only UTF-8 text without NUL bytes is read as a file", () => {
  assert.equal(decodeText(new TextEncoder().encode("héllo")), "héllo");
  assert.equal(decodeText(new Uint8Array([0xff, 0xfe, 0x00])), undefined);
  assert.equal(decodeText(new TextEncoder().encode("a\0b")), undefined);
  assert.equal(countLines(""), 0);
  assert.equal(countLines("one"), 1);
  assert.equal(countLines("one\ntwo\n"), 2);
});
