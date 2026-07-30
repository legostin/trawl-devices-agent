import { AgentError } from "./types.js";
import { formatArg } from "./codegen.js";
import { toRows, type Row } from "./rows.js";
import { slug } from "./mapStore.js";

export type StructureCommand =
  | { kind: "group"; ids: string[]; name: string }
  | { kind: "ungroup"; section: string }
  | { kind: "rename"; section: string; name: string }
  | { kind: "extract"; section: string; path?: string }
  | { kind: "moveSection"; section: string; before: string | null };

export interface StructureResult {
  code: string;
  /** Written by the caller: this module does not touch the workspace. */
  extracted?: { path: string; code: string };
}

const lineStart = (code: string, at: number): number => code.lastIndexOf("\n", at - 1) + 1;
const lineEnd = (code: string, at: number): number => {
  const end = code.indexOf("\n", at - 1);
  return end < 0 ? code.length : end + 1;
};

const sectionRows = (rows: Row[], section: string): Row[] => {
  const found = rows.filter((r) => r.section === section);
  if (!found.length) throw new AgentError("script", `секция «${section}» не найдена`);
  return found;
};

/** Where the body of a section sits, ignoring its header and closing line. */
const bodySpan = (code: string, body: Row[]): [number, number] => [
  lineStart(code, body[0]!.range[0]),
  lineEnd(code, body[body.length - 1]!.range[1]),
];

/**
 * The whole `step('name', () => {` … `})` block. The header is the line above
 * the body and the closer the line below it — both shapes we emit ourselves.
 */
const sectionSpan = (code: string, body: Row[]): [number, number] => {
  const [first, last] = bodySpan(code, body);
  return [lineStart(code, first - 1), lineEnd(code, last + 1)];
};

const dedent = (text: string): string =>
  text
    .split("\n")
    .map((line) => line.replace(/^ {2}/, ""))
    .join("\n");

export function applyStructure(code: string, command: StructureCommand): StructureResult {
  const rows = toRows(code);

  if (command.kind === "group") {
    const chosen = command.ids.map((id) => {
      const row = rows.find((r) => r.id === id);
      if (!row) throw new AgentError("script", `строка ${id} не найдена`);
      return row;
    });
    const first = rows.indexOf(chosen[0]!);
    const contiguous = chosen.every((row, i) => rows[first + i] === row);
    if (!contiguous) throw new AgentError("script", "в секцию собираются только шаги, идущие подряд");

    const start = lineStart(code, chosen[0]!.range[0]);
    const end = lineEnd(code, chosen[chosen.length - 1]!.range[1]);
    const body = code
      .slice(start, end)
      .replace(/\n$/, "")
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n");
    return {
      code: `${code.slice(0, start)}step(${formatArg(command.name)}, () => {\n${body}\n})\n${code.slice(end)}`,
    };
  }

  const body = sectionRows(rows, command.section);

  if (command.kind === "moveSection") {
    const [start, end] = sectionSpan(code, body);
    const block = code.slice(start, end);
    const without = code.slice(0, start) + code.slice(end);

    if (command.before === null) {
      return { code: `${without.endsWith("\n") || !without ? without : `${without}\n`}${block}` };
    }
    // Resolved against the original parse and then shifted by the cut: row ids
    // come from position, so re-finding the anchor would land elsewhere.
    const target = sectionRows(rows, command.before);
    const [targetStart] = sectionSpan(code, target);
    const at = targetStart > start ? targetStart - (end - start) : targetStart;
    return { code: without.slice(0, at) + block + without.slice(at) };
  }

  if (command.kind === "rename") {
    const [start] = sectionSpan(code, body);
    const headerEnd = code.indexOf("\n", start);
    const header = code.slice(start, headerEnd);
    const renamed = header.replace(/step\(\s*(['"]).*?\1/, `step(${formatArg(command.name)}`);
    return { code: code.slice(0, start) + renamed + code.slice(headerEnd) };
  }

  const [start, end] = sectionSpan(code, body);
  const inner = dedent(code.slice(...bodySpan(code, body)));

  if (command.kind === "ungroup") return { code: code.slice(0, start) + inner + code.slice(end) };

  const path = command.path ?? `scripts/${slug(command.section)}.js`;
  return {
    code: `${code.slice(0, start)}run(${formatArg(path)})\n${code.slice(end)}`,
    extracted: { path, code: inner },
  };
}
