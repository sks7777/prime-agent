//! Test-only shared state: one crate-wide lock for the process env.

/// Process-wide env reads and writes (the telemetry override vars)
/// serialize through one lock across the crate's test modules: parallel
/// test threads in the same binary otherwise race the process env. Both
/// the supervisor tests' scrub guard and `agent_engine`'s
/// `telemetry_opt_in` hold this lock through their restores.
#[cfg(test)]
pub(crate) static TELEMETRY_ENV_MUTEX: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Scrubs ambient provider credentials from the process env for the
/// guard's lifetime: `get_available` counts a provider authenticated
/// when its env key is set, so a developer/exported env leaks the
/// compiled-fallback catalog into startup-chain tests. Every provider's
/// key vars plus `PRIME_TEAM_ID` are saved on acquire and restored on
/// drop, serialized through [`TELEMETRY_ENV_MUTEX`].
#[cfg(test)]
pub(crate) struct ScrubbedProviderEnv {
    saved: Vec<(&'static str, Option<std::ffi::OsString>)>,
    _env_lock: std::sync::MutexGuard<'static, ()>,
}

#[cfg(test)]
impl ScrubbedProviderEnv {
    pub(crate) fn acquire() -> Self {
        let env_lock = TELEMETRY_ENV_MUTEX
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut saved = Vec::new();
        for provider in pa_ai::models_generated::get_providers() {
            if let Some(vars) = pa_ai::env_api_keys::get_api_key_env_vars(provider) {
                for var in vars {
                    saved.push((var, std::env::var_os(var)));
                    std::env::remove_var(var);
                }
            }
        }
        saved.push(("PRIME_TEAM_ID", std::env::var_os("PRIME_TEAM_ID")));
        std::env::remove_var("PRIME_TEAM_ID");
        Self {
            saved,
            _env_lock: env_lock,
        }
    }
}

#[cfg(test)]
impl Drop for ScrubbedProviderEnv {
    fn drop(&mut self) {
        for (name, value) in self.saved.drain(..) {
            match value {
                Some(value) => std::env::set_var(name, value),
                None => std::env::remove_var(name),
            }
        }
    }
}
