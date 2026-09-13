# Migrations — naming convention

## Filename format

```
YYYYMMDDHHMMSS_description.sql
```

- **Use a full timestamp (`HHMMSS`), not just a date with `000000`.**
  Supabase CLI versions migrations by the 14-digit prefix. Two files created
  on the same day with `000000` collide on the same version, which breaks
  `supabase db push` with `duplicate key violates schema_migrations_pkey`
  (seen 2026-09: `20260908000000_parity_cleanup` vs the delete-policy file).
- Generate the prefix from the current time, e.g.
  `date +%Y%m%d%H%M%S`, and sanity-check uniqueness before pushing:
  `ls | grep -oE '^[0-9]{14}' | sort | uniq -d` (empty output = safe).
- Never rename or edit a migration that has already been pushed to remote;
  add a new timestamped migration instead. The CLI records applied versions
  in `supabase_migrations.schema_migrations`, so history and files must stay
  in 1:1 correspondence.
