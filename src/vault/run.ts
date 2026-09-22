/**
 * The vault step of a sync: bring the index up to date, append new highlights to book notes
 * (linked to your notes), file the commands the sync owns, and handle the existing-highlights
 * question. Used by kindle_sync, kindle_export_to_obsidian and the CLI. One process at a time
 * writes to a vault (a lease in kindle.db), and nothing is written on a half-read index.
 */
import { randomUUID } from "node:crypto";

import { commandSpec } from "../commands.js";
import type { Config } from "../config.js";
import { exportBook } from "../obsidian.js";
import type { Store } from "../store.js";
import { applyBackfill, planBackfill } from "./backfill.js";
import { fileCommand, legacyAgentOutput, type FileContext } from "./file.js";
import { VaultIndex } from "./index.js";
import { Vault, VaultError } from "./write.js";

export const LEASE = "vault";
const LEASE_MS = 120_000;
const OFFER_EVERY_MS = 7 * 86_400_000;

export interface LinkExistingOffer {
  blocks: number;
  links: number;
  samples: Array<{ book: string; before: string; after: string }>;
  ask_user: string;
}

export interface VaultStepResult {
  vault: string;
  /** Why nothing was written this time; the next sync carries on. */
  skipped?: "indexing" | "busy";
  error?: string;
  highlights_written: number;
  links_added: number;
  books_written: number;
  /** Book notes deleted in Obsidian and left deleted. */
  deleted_book_notes: string[];
  filed: Array<{ tag: string; to: string; count: number }>;
  unrouted: Array<{ tag: string; arg: string; reason: string }>;
  /** Commands a 1.0 router had already written up. */
  found_earlier: number;
  link_existing?: LinkExistingOffer | { applied: { blocks: number; links: number; conflicts: string[] } };
}

export interface VaultStepOptions {
  /** Epoch ms after which reading the vault stops (the index says so and nothing is written). */
  deadline?: number;
  /** An explicit export of one book recreates its note even if it was deleted. */
  restoreBook?: string | null;
  /** Put the existing-highlights question in the result (an MCP client can ask it; cron can't). */
  offerLinkExisting?: boolean;
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Runs `fn` holding the vault lease, waiting up to `waitMs` for another process to finish. */
export function withVaultLease<T>(store: Store, fn: () => T, waitMs = 5000): T | "busy" {
  const holder = `${process.pid}:${randomUUID()}`;
  const until = Date.now() + waitMs;
  while (!store.acquireLease(LEASE, holder, LEASE_MS)) {
    if (Date.now() > until) return "busy";
    sleep(200);
  }
  try {
    return fn();
  } finally {
    store.releaseLease(LEASE, holder);
  }
}

export interface OpenVault {
  ctx: FileContext;
  index: VaultIndex;
  complete: boolean;
  close(): void;
}

/**
 * Opens the vault and its index, refreshed up to `deadline`. Anything that writes walks the
 * vault first (`fresh`), so a note moved a moment ago is found where it is now. Throws
 * VaultError for a missing vault.
 */
export function openVault(cfg: Config, store: Store, deadline = Number.POSITIVE_INFINITY, fresh = true): OpenVault {
  const vault = Vault.open(cfg.obsidianVault!, cfg.obsidianFolder);
  const index = VaultIndex.open(cfg.home, vault.root, { kindleFolder: vault.folder, exclude: cfg.linkExclude });
  try {
    const { complete } = index.refresh(deadline, fresh);
    const ctx: FileContext = { store, vault, index, linker: index.linker(), linkNotes: cfg.linkNotes };
    return { ctx, index, complete, close: () => index.close() };
  } catch (e) {
    index.close();
    throw e;
  }
}

/** A readable reason for a vault that can't be written, with the fix. */
export function vaultErrorMessage(e: unknown): string {
  const code = (e as NodeJS.ErrnoException).code;
  if (code === "EPERM" || code === "EACCES") {
    return (
      "This app is not allowed to write to the vault folder. On macOS, open System Settings > Privacy & Security > " +
      "Files and Folders (or Full Disk Access) and allow Claude, then sync again."
    );
  }
  return e instanceof VaultError ? e.message : `Vault update failed: ${(e as Error).message}`;
}

const prefKey = (vault: Vault): string => `link_existing:${vault.root}`;
const offeredKey = (vault: Vault): string => `link_existing_offered:${vault.root}`;

/** always | never | null (not answered yet). */
export function linkExistingPreference(store: Store, vault: Vault): "always" | "never" | null {
  const v = store.getState(prefKey(vault));
  return v === "always" || v === "never" ? v : null;
}

export function setLinkExistingPreference(store: Store, vault: Vault, value: "always" | "never"): void {
  store.setState(prefKey(vault), value);
}

export function askUser(blocks: number, links: number): string {
  return (
    `Ask the user, in these words or close: "I can add ${links} link${links === 1 ? "" : "s"} to your notes inside ` +
    `${blocks} highlight${blocks === 1 ? "" : "s"} you exported earlier. Only text you haven't edited changes. Add them ` +
    `now, and keep doing it when new notes match?" If yes: call kindle_link_existing_highlights with apply true and ` +
    `remember "always". If just this once: apply true. If no: remember "never". Don't apply without a yes.`
  );
}

export function runVaultStep(cfg: Config, store: Store, opts: VaultStepOptions = {}): VaultStepResult {
  const result: VaultStepResult = {
    vault: cfg.obsidianVault ?? "",
    highlights_written: 0,
    links_added: 0,
    books_written: 0,
    deleted_book_notes: [],
    filed: [],
    unrouted: [],
    found_earlier: 0,
  };
  let open: OpenVault;
  try {
    open = openVault(cfg, store, opts.deadline);
  } catch (e) {
    return { ...result, error: vaultErrorMessage(e) };
  }
  try {
    if (!open.complete) return { ...result, skipped: "indexing" };
    const { ctx } = open;
    const ran = withVaultLease(store, () => {
      // 1. New highlights into their book notes.
      for (const b of store.listBooks(null, 100000).filter((x) => x.highlight_count)) {
        const r = exportBook(store, b.book_id, {
          vault: ctx.vault,
          index: open.index,
          linker: cfg.linkNotes ? ctx.linker : null,
          restore: opts.restoreBook ? store.findBook(opts.restoreBook)?.book_id === b.book_id : false,
        });
        if (r.skipped === "deleted") result.deleted_book_notes.push(b.title);
        else if (r.added) {
          result.books_written++;
          result.highlights_written += r.added;
          result.links_added += r.links_added;
        }
      }
      // 2. Commands the sync owns; agent commands a 1.0 router already wrote up.
      const filed = new Map<string, number>();
      for (const h of store.pendingCommands(null, Number.MAX_SAFE_INTEGER)) {
        for (const c of h.remaining!) {
          const spec = commandSpec(c.tag);
          if (spec?.doneBy === "agent") {
            const earlier = legacyAgentOutput(ctx, h, c);
            if (earlier) {
              store.recordOutput(h, c, { via: "sync", path: earlier });
              result.found_earlier++;
            }
            continue;
          }
          if (!cfg.autoFile) continue;
          const f = fileCommand(ctx, store.getHighlight(h.id)!, c);
          if (f.outcome === "found") result.found_earlier++;
          else if (f.outcome === "unrouted") result.unrouted.push({ tag: f.tag, arg: f.arg, reason: f.reason ?? "" });
          else filed.set(`${f.tag}\n${f.to}`, (filed.get(`${f.tag}\n${f.to}`) ?? 0) + 1);
        }
      }
      result.filed = [...filed].map(([k, count]) => ({ tag: k.split("\n")[0], to: k.split("\n")[1], count }));
      // 3. Links in highlights exported before: only with the user's yes.
      const pref = linkExistingPreference(store, ctx.vault);
      if (pref === "always") {
        const applied = applyBackfill(ctx);
        if (applied.blocks) result.link_existing = { applied };
      } else if (pref === null && opts.offerLinkExisting && cfg.linkNotes) {
        const last = Number(store.getState(offeredKey(ctx.vault)) ?? 0);
        if (Date.now() - last > OFFER_EVERY_MS) {
          const plan = planBackfill(ctx);
          if (plan.links) {
            result.link_existing = { blocks: plan.blocks, links: plan.links, samples: plan.samples, ask_user: askUser(plan.blocks, plan.links) };
            store.setState(offeredKey(ctx.vault), String(Date.now()));
          }
        }
      }
    });
    if (ran === "busy") return { ...result, skipped: "busy" };
    return result;
  } catch (e) {
    return { ...result, error: vaultErrorMessage(e) };
  } finally {
    open.close();
  }
}
