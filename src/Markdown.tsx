import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math-extended";
import rehypeKatex from "rehype-katex";
import { visit } from "unist-util-visit";
import type { Root } from "mdast";
import "katex/dist/katex.min.css";

function keepMathFencesLiteral() {
  return (tree: Root) => {
    // rehype-katex also recognizes language-math code fences.
    visit(tree, "code", (node) => {
      if (node.lang === "math") node.lang = null;
    });
  };
}

// A one-line, symbol-free version of Markdown for labels and chips.
export function plainText(markdown: string) {
  return markdown
    .replace(/[#*_`>|~[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export const Markdown = memo(function Markdown({ content }: { content: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath, keepMathFencesLiteral]}
        rehypePlugins={[[rehypeKatex, { trust: false, maxSize: 20 }]]}
        skipHtml
        components={{
          a: ({ children, ...props }) => (
            <a {...props} className="nodrag nopan" target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
          img: ({ alt }) => (
            <span className="image-label">
              [Image: {alt || "external image"}]
            </span>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});
