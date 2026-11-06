// The value config-backup.mts writes in place of every DAZL_MASTER_KEY* assignment in the secrets/config bundle, and
// replacement-drill.mts expects to find there (issue #360). The master key is restored from its own offline store.
export const PLACEHOLDER_VALUE = '__RESTORE_FROM_OFFLINE_KEY_STORE__'
