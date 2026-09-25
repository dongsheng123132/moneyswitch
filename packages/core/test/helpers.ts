import { openDb } from "@moneyswitch/db";
import type { MoneySwitchDb } from "@moneyswitch/db";
import Database from "better-sqlite3";

export function freshDb(): { db: MoneySwitchDb; sqlite: Database.Database } {
  return openDb({ filePath: ":memory:" });
}
