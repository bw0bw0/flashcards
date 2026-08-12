use std::sync::Mutex;

use rusqlite::Connection;

use crate::error::Result;

/// Shared handle to the SQLite connection, stored in Tauri's managed state.
pub struct Db(pub Mutex<Connection>);

/// How the commands receive the database. Tauri hands it over as managed state;
/// under `cargo test` it is a plain reference, so the commands can be called
/// directly without standing up a Tauri runtime.
#[cfg(not(test))]
pub type DbState<'a> = tauri::State<'a, Db>;
#[cfg(test)]
pub type DbState<'a> = &'a Db;

impl Db {
    /// Only the Tauri entry point opens a file, and that is not built for tests.
    #[cfg_attr(test, allow(dead_code))]
    pub fn open(path: &std::path::Path) -> Result<Self> {
        let conn = Connection::open(path)?;
        prepare(&conn)?;
        Ok(Db(Mutex::new(conn)))
    }

    /// In-memory database, used by the tests.
    #[cfg(test)]
    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        prepare(&conn)?;
        Ok(Db(Mutex::new(conn)))
    }

    /// Runs `f` with the connection locked. Panics only if another thread
    /// panicked while holding the lock, which we cannot recover from anyway.
    pub fn with<T>(&self, f: impl FnOnce(&mut Connection) -> Result<T>) -> Result<T> {
        let mut guard = self.0.lock().expect("database mutex poisoned");
        f(&mut guard)
    }
}

fn prepare(conn: &Connection) -> Result<()> {
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    migrate(conn)?;
    Ok(())
}

/// Ordered list of migrations. Never edit an existing entry, only append.
const MIGRATIONS: &[&str] = &[
    include_str!("migrations/0001_initial.sql"),
    include_str!("migrations/0002_sr_daily_limits.sql"),
];

fn migrate(conn: &Connection) -> Result<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    for (i, sql) in MIGRATIONS.iter().enumerate() {
        let target = i as i64 + 1;
        if version >= target {
            continue;
        }
        conn.execute_batch(sql)?;
        conn.pragma_update(None, "user_version", target)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrations_apply_and_are_idempotent() {
        let db = Db::open_in_memory().expect("schema should apply");
        db.with(|conn| {
            let version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
            assert_eq!(version, MIGRATIONS.len() as i64);
            // Running them again must be a no-op rather than an error.
            migrate(conn)?;
            let tables: i64 = conn.query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'card'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(tables, 1);
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn deleting_a_deck_cascades_to_its_cards() {
        let db = Db::open_in_memory().unwrap();
        db.with(|conn| {
            conn.execute(
                "INSERT INTO deck (id, name, kind, created_at) VALUES (1, 'd', 'normal', '')",
                [],
            )?;
            conn.execute(
                "INSERT INTO card (deck_id, idx, front) VALUES (1, 1, 'a')",
                [],
            )?;
            conn.execute("DELETE FROM deck WHERE id = 1", [])?;
            let cards: i64 = conn.query_row("SELECT COUNT(*) FROM card", [], |row| row.get(0))?;
            assert_eq!(cards, 0);
            Ok(())
        })
        .unwrap();
    }
}
