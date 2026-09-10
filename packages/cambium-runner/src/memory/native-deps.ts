/**
 * Genuine resolvability probe for the optional native SQLite deps
 * (`better-sqlite3`, `sqlite-vec` — declared as `optionalDependencies`
 * in this package's package.json). Tests that exercise `SqliteMemoryBackend`
 * must SKIP on a box without the native build, not fail — an
 * optionalDependency that tests treat as required is a contradiction.
 *
 * Mirrors the dynamic-import-and-catch pattern `loadDatabase` /
 * `loadSqliteVec` (backend.ts) already use to produce the "install
 * better-sqlite3" error: the only way to know a native dep is usable is
 * to actually try loading it.
 *
 * The importer params default to the real dynamic `import()` — the
 * genuine probe used at every call site — and exist only so
 * native-deps.test.ts can exercise both the true and false branch of
 * this exact function without depending on the native build being
 * present or absent on the machine running the tests.
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
