/** node:sqlite still emits an ExperimentalWarning on Node 22. Keep it out of cron logs and MCP host logs. */
export function quietExperimentalWarnings(): void {
  const emitWarning = process.emitWarning.bind(process);
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const type = typeof rest[0] === "string" ? rest[0] : (rest[0] as { type?: string } | undefined)?.type;
    if (type === "ExperimentalWarning" || (warning as Error)?.name === "ExperimentalWarning") return;
    (emitWarning as (...args: unknown[]) => void)(warning, ...rest);
  }) as typeof process.emitWarning;
}
