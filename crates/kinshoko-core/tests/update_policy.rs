use kinshoko_core::{UpdateChannel, UpdatePolicy, UpdateStatus, offers_update};

const ENDPOINT: &str = "https://github.com/Yukk1No/kinshoko/releases/latest/download/latest.json";

#[test]
fn manual_builds_explain_package_updates_without_claiming_repository_visibility() {
    let policy = UpdatePolicy::for_build(
        Some("private"),
        Some("paired-public-key"),
        &[ENDPOINT.to_owned()],
    );
    assert_eq!(
        policy.initial_status(),
        UpdateStatus::Manual {
            message: kinshoko_core::CommandError::new(
                kinshoko_core::command_error::ErrorKind::UpdateManual,
                "当前使用安装包手动更新。",
            ),
        }
    );
    assert!(
        policy
            .require_automatic()
            .unwrap_err()
            .to_string()
            .to_string()
            .contains("手动更新")
    );
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
            .to_string()
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
        assert!(
            missing
                .require_automatic()
                .unwrap_err()
                .to_string()
                .contains("原仓库")
        );
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
            .to_string()
            .contains("阶段配置")
    );
}

const BETA_ENDPOINT: &str =
    "https://github.com/Yukk1No/kinshoko/releases/download/channel-beta/latest.json";

#[test]
fn public_builds_accept_either_original_channel_endpoint_but_nothing_else() {
    for endpoints in [
        vec![BETA_ENDPOINT.to_owned()],
        vec![ENDPOINT.to_owned(), BETA_ENDPOINT.to_owned()],
    ] {
        let ready = UpdatePolicy::for_build(Some("public"), Some("paired-public-key"), &endpoints);
        assert_eq!(ready.initial_status(), UpdateStatus::Unchecked);
    }

    let mixed = UpdatePolicy::for_build(
        Some("public"),
        Some("paired-public-key"),
        &[
            BETA_ENDPOINT.to_owned(),
            "https://github.com/someone/kinshoko/releases/download/channel-beta/latest.json"
                .to_owned(),
        ],
    );
    assert!(
        mixed
            .require_automatic()
            .unwrap_err()
            .to_string()
            .contains("原仓库")
    );
}

#[test]
fn each_channel_checks_its_own_original_endpoint() {
    assert_eq!(UpdateChannel::Stable.endpoint(), ENDPOINT);
    assert_eq!(UpdateChannel::Beta.endpoint(), BETA_ENDPOINT);
}

#[test]
fn prerelease_builds_default_to_the_beta_channel() {
    assert_eq!(
        UpdateChannel::default_for_version("1.0.0-beta.1"),
        UpdateChannel::Beta
    );
    assert_eq!(
        UpdateChannel::default_for_version("1.0.0-rc.2"),
        UpdateChannel::Beta
    );
    assert_eq!(
        UpdateChannel::default_for_version("1.0.0"),
        UpdateChannel::Stable
    );
    assert_eq!(
        UpdateChannel::default_for_version("0.1.0"),
        UpdateChannel::Stable
    );
}

#[test]
fn only_strictly_newer_releases_are_offered_so_switching_back_to_stable_never_downgrades() {
    let v = |s: &str| semver::Version::parse(s).unwrap();
    // 测试版之间、候选版到正式版按 SemVer 往前走。
    assert!(offers_update(&v("1.0.0-beta.1"), &v("1.0.0-beta.2")));
    assert!(offers_update(&v("1.0.0-beta.9"), &v("1.0.0-beta.10")));
    assert!(offers_update(&v("1.0.0-beta.3"), &v("1.0.0-rc.1")));
    assert!(offers_update(&v("1.0.0-rc.1"), &v("1.0.0")));
    // 装着 1.1.0-beta.1 切回正式版通道，latest 还是 1.0.0：不提示。
    assert!(!offers_update(&v("1.1.0-beta.1"), &v("1.0.0")));
    assert!(!offers_update(&v("1.0.0"), &v("1.0.0")));
    assert!(!offers_update(&v("1.0.0"), &v("1.0.0-rc.1")));
}
