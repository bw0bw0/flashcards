import { invalid } from "./db.ts";

/** The JSON arguments of a command, as sent by the app. */
export type Args = Record<string, unknown>;

function fail(name: string, expected: string): never {
  throw invalid(`missing or invalid argument \`${name}\` (expected ${expected})`);
}

export function int(args: Args, name: string): number {
  const value = args[name];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) fail(name, "an integer");
  return value;
}

export function optInt(args: Args, name: string): number | null {
  const value = args[name];
  return value === undefined || value === null ? null : int(args, name);
}

export function str(args: Args, name: string): string {
  const value = args[name];
  if (typeof value !== "string") fail(name, "a string");
  return value;
}

export function optStr(args: Args, name: string): string | null {
  const value = args[name];
  return value === undefined || value === null ? null : str(args, name);
}

export function bool(args: Args, name: string): boolean {
  const value = args[name];
  if (typeof value !== "boolean") fail(name, "true or false");
  return value;
}

export function intArray(args: Args, name: string): number[] {
  const value = args[name];
  if (!Array.isArray(value) || !value.every((v) => Number.isSafeInteger(v))) {
    fail(name, "a list of integers");
  }
  return value as number[];
}

export interface CardSelection {
  deckId: number;
  fromIndex: number | null;
  toIndex: number | null;
}

function toSelection(value: unknown, name: string): CardSelection {
  if (typeof value !== "object" || value === null) fail(name, "a card selection");
  const v = value as Args;
  return {
    deckId: int(v, "deckId"),
    fromIndex: optInt(v, "fromIndex"),
    toIndex: optInt(v, "toIndex"),
  };
}

export function selection(args: Args, name: string): CardSelection {
  return toSelection(args[name], name);
}

export function selections(args: Args, name: string): CardSelection[] {
  const value = args[name];
  if (!Array.isArray(value)) fail(name, "a list of card selections");
  return value.map((item) => toSelection(item, name));
}
