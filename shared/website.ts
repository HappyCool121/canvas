// Answers that contain an HTML page render as a small website. The page runs
// in a sandboxed frame with an opaque origin, so it can't reach Canvas, its
// keys or its files, and this policy blocks every outside request.
export const WEBSITE_POLICY =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; form-action 'none'; base-uri 'none'";

type Block = { lang: string; code: string };

// Fenced code blocks in Markdown, in order.
export function codeBlocks(markdown: string): Block[] {
  const lines = markdown.split(/\r?\n/);
  const blocks: Block[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(/^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)/);
    if (!open) continue;
    const marker = open[1];
    const body: string[] = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const close = lines[j].match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
      if (close && close[1][0] === marker[0] && close[1].length >= marker.length) break;
      body.push(lines[j]);
    }
    blocks.push({ lang: open[2].toLowerCase(), code: body.join("\n") });
    i = j;
  }
  return blocks;
}

const DOCUMENT = /^\s*(<!doctype html|<html[\s>])/i;

// The page an answer describes: its last HTML block (or the whole answer when
// it is a document), with any CSS and JavaScript blocks added inline.
export function extractWebsite(markdown: string): string | undefined {
  const blocks = codeBlocks(markdown);
  const html = [...blocks].reverse().find((b) => ["html", "htm", "xhtml"].includes(b.lang) || (!b.lang && DOCUMENT.test(b.code)));
  const page = html ? html.code : DOCUMENT.test(markdown) ? markdown : undefined;
  if (!page || !/<[a-z!]/i.test(page)) return undefined;
  const css = blocks.filter((b) => b.lang === "css").map((b) => b.code);
  const js = blocks.filter((b) => ["js", "javascript", "mjs"].includes(b.lang)).map((b) => b.code);
  let result = page;
  if (css.length) {
    const style = `<style>\n${css.join("\n\n").replace(/<\/style/gi, "<\\/style")}\n</style>`;
    result = /<\/head>/i.test(result) ? result.replace(/<\/head>/i, `${style}\n</head>`) : `${style}\n${result}`;
  }
  if (js.length) {
    const script = `<script>\n${js.join("\n\n").replace(/<\/script/gi, "<\\/script")}\n</script>`;
    result = /<\/body>/i.test(result) ? result.replace(/<\/body>(?![\s\S]*<\/body>)/i, `${script}\n</body>`) : `${result}\n${script}`;
  }
  return result;
}

// The document the frame loads: the policy comes first, right after any
// doctype, so it covers everything the page contains.
export function sandboxedPage(page: string) {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${WEBSITE_POLICY}">`;
  const doctype = page.match(/^\s*<!doctype[^>]*>/i);
  return doctype ? `${doctype[0]}${meta}${page.slice(doctype[0].length)}` : `<!doctype html>${meta}${page}`;
}
