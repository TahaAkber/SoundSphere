# Quran audio implementation

See `quran.rs` for the running Surah/ayah/Juz adapter and EveryAyah alternatives.
Chapter and verse reciter IDs come from their respective API resource lists;
they are not assumed to be interchangeable.

The bundled 114-chapter catalog is official public API metadata. Audio URLs come
from the Quran Foundation response. EveryAyah candidates map only the same Qari
and ayah; playback checks their availability before loading them.

Personal offline downloads are enabled for Quran Foundation sources with reciter
credit and their Developer Terms retained in the source metadata. EveryAyah
downloads remain disabled. See:

- https://api-docs.quran.com/docs/tutorials/faq/
- https://api-docs.quran.com/docs/quickstart/
- https://everyayah.com/data/recitations.js

For authenticated Content APIs, use a server-side proxy through
`QURAN_API_BASE_URL`; do not distribute a client secret inside this application.
