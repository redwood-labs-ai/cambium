/** Shared native-dependency resolvability probe for CLI-level tests that
 *  exercise the SQLite-backed memory subsystem (RED-215).
 *
 *  `better-sqlite3` and `sqlite-vec` are `optionalDependencies` of
 *  @redwood-labs/cambium-runner — a box without the native build must
 *  SKIP these tests, not fail them. The importer params default to the
 *  real dynamic `import()` (the genuine probe every call site uses) and
 *  exist only so native-deps.test.ts can drive both branches of this
 *  exact function without depending on the native build being present
 *  or absent on the machine running the tests.
 */

export async function betterSqlite3Available(
  importBetterSqlite3: () => Promise<any> = () => import('better-sqlite3'),
): Promise<boolean> {
  try {
    const mod: any = await importBetterSqlite3();
    const Database = mod.default ?? mod;
    const db = new Database(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}

export async function sqliteVecAvailable(
  importBetterSqlite3: () => Promise<any> = () => import('better-sqlite3'),
  importSqliteVec: () => Promise<any> = () => import('sqlite-vec'),
): Promise<boolean> {
  try {
    const mod: any = await importBetterSqlite3();
    const Database = mod.default ?? mod;
    const sqliteVec: any = await importSqliteVec();
    const db = new Database(':memory:');
    sqliteVec.load(db);
    db.close();
    return true;
  } catch {
    return false;
  }
}
