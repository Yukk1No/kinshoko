use kinshoko_core::{UpdatePolicy, UpdateStatus};

const ENDPOINT: &str = "https://github.com/Yukk1No/kinshoko/releases/latest/download/latest.json";

#[test]
fn private_builds_explain_manual_updates_even_when_signing_is_configured() {
    let policy = UpdatePolicy::for_build(
        Some("private"),
        Some("paired-public-key"),
        &[ENDPOINT.to_owned()],
    );
    assert_eq!(
        policy.initial_status(),
        UpdateStatus::Manual {
            message: "当前为私有阶段，请使用新版安装包手动更新。".to_owned(),
        }
    );
    assert!(policy.require_automatic().unwrap_err().contains("手动更新"));
}

#[test]
fn public_builds_need_the_original_public_endpoint_and_a_signing_key() {
    let ready = UpdatePolicy::for_build(
        Some("public"),
        Some("paired-public-key"),
        &[ENDPOINT.to_owned()],
    );
    assert_eq!(ready.initial_status(), UpdateStatus::Unchecked);
    assert!(ready.require_automatic().is_ok());

    let unsigned = UpdatePolicy::for_build(Some("public"), Some("  "), &[ENDPOINT.to_owned()]);
    assert!(matches!(
        unsigned.initial_status(),
        UpdateStatus::Disabled { .. }
    ));
    assert!(
        unsigned
            .require_automatic()
            .unwrap_err()
            .contains("更新公钥")
    );

    for endpoints in [
        vec![],
        vec![
            "https://github.com/someone/another-repo/releases/latest/download/latest.json"
                .to_owned(),
        ],
        vec![
            ENDPOINT.to_owned(),
            "https://example.com/fallback.json".to_owned(),
        ],
    ] {
        let missing =
            UpdatePolicy::for_build(Some("public"), Some("paired-public-key"), &endpoints);
        assert!(matches!(
            missing.initial_status(),
            UpdateStatus::Disabled { .. }
        ));
        assert!(missing.require_automatic().unwrap_err().contains("原仓库"));
    }
}

#[test]
fn absent_stage_defaults_to_private_and_unknown_stage_never_enables_actions() {
    let absent = UpdatePolicy::for_build(None, Some("paired-public-key"), &[ENDPOINT.to_owned()]);
    assert!(matches!(
        absent.initial_status(),
        UpdateStatus::Manual { .. }
    ));
    assert!(absent.require_automatic().is_err());
    let invalid = UpdatePolicy::for_build(
        Some("preview"),
        Some("paired-public-key"),
        &[ENDPOINT.to_owned()],
    );
    assert!(matches!(
        invalid.initial_status(),
        UpdateStatus::Disabled { .. }
    ));
    assert!(
        invalid
            .require_automatic()
            .unwrap_err()
            .contains("阶段配置")
    );
}
