import { specNeedsDirectoryTarget, type DropSpec } from "@peardrop/core";

export interface SpecFieldReport {
  readonly name: string;
  readonly type: string;
  readonly label: string;
  readonly required: boolean;
  readonly masked: boolean;
  readonly group?: string;
  readonly link?: string;
  readonly deliveredAs: string;
}

export interface SpecReport {
  readonly title?: string;
  readonly fieldCount: number;
  readonly fields: ReadonlyArray<SpecFieldReport>;
  readonly links: ReadonlyArray<string>;
  readonly needsDirectoryTarget: boolean;
  readonly hook?: string;
}

/** What the drop page will render and deliver, derived deterministically from a validated spec. */
export function describeSpec(spec: DropSpec): SpecReport {
  const fields = spec.fields.map((field): SpecFieldReport => ({
    name: field.name,
    type: field.type,
    label: field.label ?? field.name,
    required: field.required,
    masked: field.masked ?? (field.type === "secret" || field.type === "token"),
    ...(field.group ? { group: field.group } : {}),
    ...(field.link ? { link: field.link.url } : {}),
    deliveredAs: field.type === "file"
      ? ((field.count ?? 1) > 1 ? `${field.name}-<n>-<original name>` : `${field.name}-<original name>`)
      : `${field.name}.txt`,
  }));
  const links = [
    ...spec.groups.flatMap((group) => (group.link ? [group.link.url] : [])),
    ...spec.fields.flatMap((field) => [...(field.link ? [field.link.url] : []), ...(field.entry_url ? [field.entry_url] : [])]),
  ];
  return {
    ...(spec.title ? { title: spec.title } : {}),
    fieldCount: fields.length,
    fields,
    links,
    needsDirectoryTarget: specNeedsDirectoryTarget(spec),
    ...(spec.hooks.on_receive ? { hook: spec.hooks.on_receive } : {}),
  };
}

export function formatSpecReport(report: SpecReport): string {
  const lines = [`${report.title ? `"${report.title}"` : "(untitled page)"}: ${report.fieldCount} field${report.fieldCount === 1 ? "" : "s"}${report.needsDirectoryTarget ? " — needs a directory target ending in /" : ""}`];
  for (const field of report.fields) {
    lines.push(`  ${field.name} (${field.type}${field.masked ? ", masked" : ""}${field.required ? "" : ", optional"}${field.group ? `, group ${field.group}` : ""}) "${field.label}" -> ${field.deliveredAs}${field.link ? `  link ${field.link}` : ""}`);
  }
  if (report.links.length > 0) lines.push(`  links: ${report.links.join(" ")}`);
  if (report.hook) lines.push(`  on_receive: ${report.hook}`);
  return lines.join("\n");
}
