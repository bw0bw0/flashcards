use rusqlite::{params, Connection};
use tauri::State;

use crate::db::Db;
use crate::error::{Error, Result};
use crate::models::Category;

fn read(conn: &Connection, id: i64) -> Result<Category> {
    conn.query_row(
        "SELECT id, name, position FROM category WHERE id = ?1",
        params![id],
        |row| {
            Ok(Category {
                id: row.get(0)?,
                name: row.get(1)?,
                position: row.get(2)?,
            })
        },
    )
    .map_err(|_| Error::invalid("category not found"))
}

#[tauri::command]
pub fn list_categories(db: State<'_, Db>) -> Result<Vec<Category>> {
    db.with(|conn| {
        let mut stmt =
            conn.prepare("SELECT id, name, position FROM category ORDER BY position, name")?;
        let rows = stmt.query_map([], |row| {
            Ok(Category {
                id: row.get(0)?,
                name: row.get(1)?,
                position: row.get(2)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    })
}

#[tauri::command]
pub fn create_category(db: State<'_, Db>, name: String) -> Result<Category> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err(Error::invalid("category name cannot be empty"));
    }
    db.with(|conn| {
        let position: i64 = conn.query_row(
            "SELECT COALESCE(MAX(position), 0) + 1 FROM category",
            [],
            |row| row.get(0),
        )?;
        conn.execute(
            "INSERT INTO category (name, position) VALUES (?1, ?2)",
            params![name, position],
        )?;
        read(conn, conn.last_insert_rowid())
    })
}

#[tauri::command]
pub fn update_category(db: State<'_, Db>, id: i64, name: String) -> Result<Category> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err(Error::invalid("category name cannot be empty"));
    }
    db.with(|conn| {
        let changed = conn.execute(
            "UPDATE category SET name = ?2 WHERE id = ?1",
            params![id, name],
        )?;
        if changed == 0 {
            return Err(Error::invalid("category not found"));
        }
        read(conn, id)
    })
}

/// Deleting a category leaves its decks in place, uncategorised.
#[tauri::command]
pub fn delete_category(db: State<'_, Db>, id: i64) -> Result<()> {
    db.with(|conn| {
        conn.execute("DELETE FROM category WHERE id = ?1", params![id])?;
        Ok(())
    })
}
