mod commands;
mod compare;
mod config;
mod datacmp;
mod datasource;
mod error;
mod navicat;
mod secret;
mod tunnel;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let config_dir = app.path().app_config_dir()?;
            std::fs::create_dir_all(&config_dir)?;
            secret::init_local_dir(config_dir.clone());
            app.manage(config::store::ConnectionStore::new(config_dir));
            app.manage(datasource::Registry::default());
            app.manage(tunnel::TunnelManager::default());
            app.manage(commands::datacmp::DataCompareCache::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::connections::list_connections,
            commands::connections::save_connection,
            commands::connections::delete_connection,
            commands::connections::duplicate_connection,
            commands::connections::test_connection,
            commands::connections::connect,
            commands::connections::disconnect,
            commands::groups::create_group,
            commands::groups::rename_group,
            commands::groups::delete_group,
            commands::compare::compare_schema,
            commands::compare::compare_schema_multi,
            commands::compare::apply_sync,
            commands::datacmp::list_table_keys,
            commands::datacmp::compare_data_multi,
            commands::datacmp::get_table_diff_detail,
            commands::datacmp::get_table_rows_preview,
            commands::datacmp::preview_data_sync,
            commands::datacmp::apply_data_sync,
            commands::explore::list_databases,
            commands::explore::list_tables,
            commands::explore::describe_table,
            commands::navicat::navicat_scan,
            commands::navicat::navicat_import_ncx,
            commands::navicat::navicat_import,
            commands::navicat::open_config_dir,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
