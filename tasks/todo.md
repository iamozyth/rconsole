# Aufgaben: Server-Lebenszyklus

## 1. Distributionskatalog: Paper, Folia, Velocity, Vanilla
- [x] `lib/distributions.js`: `versions(id)`, `builds(id, version)`, `resolve(id, version, build)` → `{ url, algo, hash, size, file }`
- [x] Downloads nur von festen Hosts je Distribution, ohne Prüfsumme kein Download
- [x] Vanilla liefert `javaMajor` aus dem Versions-JSON
- Prüfung: `node --test test/distributions.test.js` mit lokalem Fake-API-Server
- Dateien: `lib/distributions.js`, `test/distributions.test.js`

## 2. Katalog: Purpur, Fabric, Quilt, Forge, NeoForge
- [x] Resolver je Distribution, Installer-Typ (`jar` oder `installer`) im Ergebnis
- [x] Prüfsummenstärke wird mitgeliefert (für die Oberfläche)
- Prüfung: Tests mit aufgezeichneten API-Antworten
- Abhängig von: 1

## 3. Java-Auflösung
- [x] `majorFor(distribution, mcVersion)` über Mojang, `resolveRuntime(major, arch)` über Adoptium mit SHA-256
- Abhängig von: 1

## 4. Instanzmodell
- [x] `lib/instances.js`: Laden, Validieren (id, Distribution, Version, RAM, Port, Flag-Profil), Liste
- [x] Gleiche Validierung im Helper und im Starter nutzbar
- Abhängig von: 1

## Checkpoint 1
- [x] `npm test` grün (bis auf 6 bestehende Restore-Tests, die nur unter macOS-tar scheitern), keine bestehende Funktion verändert

## 5. Units und Starter
- [x] `rconsole-mc@.service`, `rconsole-mc@.socket`, `bin/mc-launch.js`, polkit-Regel, `bin/units.sh`
- [x] Starter baut die Java-Kommandozeile nur aus validierten Feldern
- Abhängig von: 4

## 6. Helper-Jobs
- [ ] `java-install`, `server-create`, `server-install`, `server-delete` mit Tests gegen ein Temp-Verzeichnis
- Abhängig von: 2, 3, 4

## 7. Power pro Instanz, FIFO-Konsole, Autostart
- Abhängig von: 5

## 8. API für Instanzen (Rollen, Audit)
- Abhängig von: 6, 7

## Checkpoint 2
- [ ] Server per API von null an erstellt und gestartet, auf Debian getestet

## 9.–13. Oberfläche, Updates für alle, Übernehmen, Installer, Doku
- siehe `tasks/plan.md`

## Checkpoint 3
- [ ] Code-Review, Security-Review, Ende-zu-Ende auf Debian
