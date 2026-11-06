import { test } from "node:test";
import assert from "node:assert/strict";
import { codeBlocks, extractWebsite, sandboxedPage, WEBSITE_POLICY } from "../shared/website";

test("an answer's last HTML block becomes the page, with CSS and JS blocks inline", () => {
  const answer = [
    "First try:", "```html", "<p>old</p>", "```",
    "Better:", "```html", "<!doctype html><html><head><title>t</title></head><body><h1>New</h1></body></html>", "```",
    "```css", "h1 { color: red }", "```",
    "```js", "console.log('</script>')", "```",
  ].join("\n");
  const page = extractWebsite(answer)!;
  assert.match(page, /<h1>New<\/h1>/);
  assert.doesNotMatch(page, /old/);
  assert.match(page, /<style>\nh1 \{ color: red \}\n<\/style>\n<\/head>/);
  assert.match(page, /<script>\nconsole\.log\('<\\\/script>'\)\n<\/script>\n<\/body>/, "a script can't end its own tag early");
});

test("plain answers, other code and empty blocks don't render", () => {
  assert.equal(extractWebsite("Just text with <b>bold</b>."), undefined);
  assert.equal(extractWebsite("```python\nprint('<html>')\n```"), undefined);
  assert.equal(extractWebsite("```html\n\n```"), undefined);
  assert.ok(extractWebsite("<!DOCTYPE html>\n<html><body>whole answer</body></html>"));
  assert.ok(extractWebsite("```\n<!doctype html><p>unlabelled</p>\n```"));
  assert.deepEqual(codeBlocks("````md\n```html\nx\n```\n````").map((b) => b.lang), ["md"], "a longer fence holds shorter ones");
});

test("the sandbox policy comes before anything the page contains", () => {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${WEBSITE_POLICY}">`;
  assert.equal(sandboxedPage("<!DOCTYPE html><script>x</script>"), `<!DOCTYPE html>${meta}<script>x</script>`);
  assert.equal(sandboxedPage("<p>fragment</p>"), `<!doctype html>${meta}<p>fragment</p>`);
  assert.match(WEBSITE_POLICY, /default-src 'none'/);
  assert.doesNotMatch(WEBSITE_POLICY, /connect-src|https?:/, "no outside requests are allowed");
});
