import { parseYaml } from "obsidian";

function normalizeTag(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
}

function parseFrontmatterTags(frontmatter: unknown): string[] {
  if (frontmatter === null || frontmatter === undefined) return [];

  const addFromString = (s: string, out: string[]) => {
    // Support YAML like: tags: foo, bar OR tags: "foo, bar"
    for (const part of s.split(",").map((p) => p.trim())) {
      const normalized = normalizeTag(part);
      if (normalized) out.push(normalized);
    }
  };

  const out: string[] = [];
  if (typeof frontmatter === "string") {
    addFromString(frontmatter, out);
    return out;
  }

  if (Array.isArray(frontmatter)) {
    for (const item of frontmatter) {
      if (typeof item === "string") addFromString(item, out);
    }
    return out;
  }

  return [];
}

function stripFrontmatter(content: string): { frontmatterText: string | null; body: string } {
  if (!content.startsWith("---")) return { frontmatterText: null, body: content };

  // Support both \n and \r\n.
  const delimiter = content.startsWith("---\r\n") ? "\r\n" : "\n";
  const endMarker = `${delimiter}---`;
  const endIdx = content.indexOf(endMarker, 3);
  if (endIdx === -1) return { frontmatterText: null, body: content };

  const fmStart = content.indexOf(delimiter) + delimiter.length;
  const fmText = content.slice(fmStart, endIdx);
  const bodyStart = endIdx + endMarker.length;
  const body = content.slice(bodyStart).replace(/^\s+/, "");
  return { frontmatterText: fmText, body };
}

function stripCode(content: string): string {
  // Best-effort removal of code blocks to avoid false-positive tags.
  return content
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/~~~[\s\S]*?~~~/g, " ")
    .replace(/`[^`]*`/g, " ");
}

export function extractAllTags(markdownContent: string): string[] {
  const { frontmatterText, body } = stripFrontmatter(markdownContent);

  const tags = new Set<string>();

  if (frontmatterText !== null) {
    try {
      const parsed = parseYaml(frontmatterText) as any;
      for (const tag of parseFrontmatterTags(parsed?.tags)) tags.add(tag);
    } catch {
      // Ignore frontmatter parse errors; still extract inline tags.
    }
  }

  const tagRegex = /(^|[^\p{L}\p{N}_/-])#([A-Za-z0-9][A-Za-z0-9_/-]*)/gu;
  const bodyNoCode = stripCode(body);
  for (const match of bodyNoCode.matchAll(tagRegex)) {
    const normalized = normalizeTag(match[2]);
    if (normalized) tags.add(normalized);
  }

  return Array.from(tags);
}

