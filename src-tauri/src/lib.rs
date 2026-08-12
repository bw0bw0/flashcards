mod commands;
mod db;
mod error;
mod models;
mod srs;
#[cfg(test)]
mod tests;

/// The commands are plain functions under `cargo test` (see `db::DbState`), so
/// the Tauri wiring is only compiled for the real build.
#[cfg(not(test))]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use crate::db::Db;
    use tauri::Manager;

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            app.manage(Db::open(&dir.join("flashcards.db"))?);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::categories::list_categories,
            commands::categories::create_category,
            commands::categories::update_category,
            commands::categories::delete_category,
            commands::decks::list_decks,
            commands::decks::get_deck,
            commands::decks::create_deck,
            commands::decks::update_deck,
            commands::decks::delete_deck,
            commands::cards::list_cards,
            commands::cards::list_selection,
            commands::cards::create_card,
            commands::cards::update_card,
            commands::cards::delete_card,
            commands::cards::move_card,
            commands::cards::import_cards,
            commands::cards::export_cards,
            commands::sr::create_sr_deck,
            commands::sr::add_to_sr_deck,
            commands::sr::list_sr_cards,
            commands::sr::remove_sr_cards,
            commands::sr::sr_queue,
            commands::sr::sr_deck_stats,
            commands::sr::grade_sr_card,
            commands::sr::reset_sr_card,
            commands::prompts::list_story_prompts,
            commands::prompts::create_story_prompt,
            commands::prompts::update_story_prompt,
            commands::prompts::delete_story_prompt,
            commands::prompts::build_story_request,
            commands::prompts::apply_story_response,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
