# Procedure codes

DentalAppeal accepts any correctly formatted procedure code:

- **US:** ADA CDT codes, `D` + 4 digits (D2740)
- **Canada:** CDA USC&LS codes, 5 digits (27211)

The `cdt_codes` table only supplies the picker's "common codes" and the descriptions used in
letters and dentist notes. A code that isn't in the table is still accepted; the letter refers to
it by its code and the dentist's note supplies the clinical detail.

## Licensing

CDT is copyrighted by the American Dental Association and USC&LS by the Canadian Dental
Association. Load their full code files only under a licence from each association.

## Loading or updating a code set (once a year)

New CDT editions take effect every January 1. With the licensed file saved as CSV with the
columns `code`, `category`, `description`:

```bash
npm run build
# Preview first: shows how many codes are added, updated and retired; saves nothing
DATABASE_URL=<live database url> node dist/scripts/importProcedureCodes.js --file cdt-2027.csv --system CDT --edition 2027 --dry-run
# Then load it
DATABASE_URL=<live database url> node dist/scripts/importProcedureCodes.js --file cdt-2027.csv --system CDT --edition 2027
```

For Canada use `--system USCLS`. Codes missing from a new edition are marked inactive (hidden from
the picker) but kept, so older claims still show them. Migration
`006_procedure_code_editions.sql` must have been run first.
