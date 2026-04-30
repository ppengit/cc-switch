use cc_switch_lib::{write_app_config_files, AppConfigFileWrite};

#[path = "support.rs"]
mod support;
use support::{ensure_test_home, reset_test_fs, test_mutex};

#[test]
fn current_config_batch_save_skips_missing_empty_files() {
    let _guard = test_mutex().lock().expect("acquire test mutex");
    reset_test_fs();
    let home = ensure_test_home();

    futures::executor::block_on(write_app_config_files(
        "gemini".to_string(),
        vec![
            AppConfigFileWrite {
                file_key: "env".to_string(),
                content: String::new(),
            },
            AppConfigFileWrite {
                file_key: "settings".to_string(),
                content: String::new(),
            },
        ],
    ))
    .expect("empty missing files should be skipped");

    assert!(
        !home.join(".gemini").join(".env").exists(),
        "missing empty .env should not be created"
    );
    assert!(
        !home.join(".gemini").join("settings.json").exists(),
        "missing empty settings.json should not be created"
    );
}

#[test]
fn current_config_batch_save_validates_all_files_before_writing() {
    let _guard = test_mutex().lock().expect("acquire test mutex");
    reset_test_fs();
    let home = ensure_test_home();

    let result = futures::executor::block_on(write_app_config_files(
        "gemini".to_string(),
        vec![
            AppConfigFileWrite {
                file_key: "env".to_string(),
                content: "GEMINI_API_KEY=ok".to_string(),
            },
            AppConfigFileWrite {
                file_key: "settings".to_string(),
                content: "{".to_string(),
            },
        ],
    ));

    assert!(result.is_err(), "invalid settings.json should reject the batch");
    assert!(
        !home.join(".gemini").join(".env").exists(),
        "valid files must not be partially written when another file is invalid"
    );
}

