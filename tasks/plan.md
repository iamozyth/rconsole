# Umsetzungsplan: rconsole verwaltet den Minecraft-Server selbst

## Überblick

Heute hängt sich rconsole an einen fertigen systemd-Dienst (`minecraft.service`), den der Admin selbst eingerichtet hat. Ziel: rconsole erstellt, installiert, startet, stoppt, aktualisiert und entfernt Server selbst, für Vanilla, Paper, Purpur, Folia, Fabric, Quilt, Forge, NeoForge und Velocity, ohne dass jemand SSH, Java oder eine Unit-Datei anfassen muss. Was rconsole heute auszeichnet, bleibt: keine Abhängigkeiten außer Node.js, rconsole selbst schreibt nie in Serverdateien (nur geprüfte Helper-Jobs als Minecraft-Nutzer), SSO/OIDC, jede Datei mit Prüfsumme, strenges systemd-Sandboxing.

Abgrenzung zu Crafty Controller 4: Crafty bringt Python, eine Datenbank und einen eigenen Daemon mit, der als ein Nutzer alles darf. rconsole bleibt ein Node-Prozess ohne Schreibrechte, und jede Instanz läuft in ihrer eigenen gehärteten systemd-Unit.

## Architekturentscheidungen

1. **Instanzen statt `MC_DIR`.** Jeder Server ist eine Instanz `SERVERS_DIR/<id>/` (Standard `/srv/minecraft/<id>`) mit einer `instance.json` (Distribution, Minecraft-Version, Build/Loader-Version, Java-Hauptversion, RAM, Port, JVM-Profil). `<id>` ist `[a-z0-9-]{1,32}`. Das Datenmodell ist von Anfang an mehrfähig; ob die Oberfläche gleich mehrere Server zeigt, ist Frage 1 unten.
2. **Eine Unit-Vorlage für alle Server: `rconsole-mc@.service`.** Läuft als `minecraft`, mit demselben Sandboxing wie die Job-Units, plus `MemoryMax` aus der Instanz. `ExecStart` ist ein fester Starter (`bin/mc-launch.js %i`), der `instance.json` erneut prüft und `java` mit fest aufgebauten Argumenten startet. rconsole kann also keine beliebige Kommandozeile einschleusen, nur geprüfte Felder (RAM-Zahl, Flag-Profil aus einer Liste).
3. **Konsole über stdin, nicht nur RCON.** Eine `rconsole-mc@.socket`-Unit mit `ListenFIFO=/run/rconsole-mc/%i.stdin` (Gruppe `rconsole`, schreibbar) wird zum stdin des Servers. Damit funktionieren Befehle auch vor RCON-Start, für Velocity (hat kein RCON) und beim Hängen. Stoppen läuft über SIGTERM, das Minecraft sauber mit Speichern behandelt. RCON bleibt für Antworten (TPS, Spielerliste) und wird bei neuen Instanzen automatisch mit Zufallspasswort eingerichtet, nur auf 127.0.0.1.
4. **polkit wird enger statt weiter.** Erlaubt nur `start/stop/restart` auf `rconsole-mc@<id>.service` (Regex) und die bestehenden Job-Units. Autostart nach einem Reboot macht rconsole selbst (Flag in `instance.json`), so braucht es kein `enable` und keine Unit-Datei-Rechte.
5. **Installation als Helper-Jobs.** Neue Job-Arten in `bin/mc-helper.js`: `server-create` (Ordner, `instance.json`, `server.properties`, `eula.txt`), `server-install` (Distribution laden und prüfen, im `rconsole-net@`), `java-install` (Temurin-JRE der passenden Version nach `SERVERS_DIR/.java/<major>`), `server-delete` (vorher Archiv ins Backup-Verzeichnis). Alles wird im Helper aus der Distribution neu aufgelöst, nie aus Angaben von rconsole übernommen, genau wie heute bei Paper und Modrinth.
6. **Ein Katalog `lib/distributions.js`** mit je einem Resolver pro Distribution: Versionen, Builds, Download-URL, Prüfsumme, erlaubte Hosts, Java-Version. Ersetzt `lib/paper.js` und erweitert Updates von Paper/Folia auf alle Distributionen.
7. **Java ohne apt.** Die Java-Hauptversion kommt aus Mojangs Versions-JSON (`javaVersion.majorVersion`), die JRE von Adoptium (Temurin) mit SHA-256 aus deren API. Kein System-Java nötig, mehrere Versionen nebeneinander.
8. **EULA wird nicht stillschweigend akzeptiert.** Der Assistent zeigt die Minecraft-EULA mit Link und verlangt ein Häkchen; erst dann schreibt der Helper `eula=true`. Wer akzeptiert hat, steht im Audit-Log.
9. **Bestehende Server bleiben unterstützt.** Der heutige Modus („externer Server“ mit eigenem `MC_SERVICE`) läuft unverändert weiter. Zusätzlich gibt es **Übernehmen**: rconsole liest Ordner und Jar, legt eine `instance.json` an und startet ihn künftig über `rconsole-mc@`. Der alte Dienst wird nur nach Bestätigung deaktiviert.

## Wie gut sich jede Distribution prüfen lässt

| Distribution | Quelle | Prüfsumme | Installation |
|---|---|---|---|
| Vanilla | Mojang piston-meta | SHA-1 aus Mojangs Manifest | Jar direkt |
| Paper, Folia, Velocity | PaperMC Fill v3 | SHA-256 | Jar direkt |
| Purpur | api.purpurmc.org | MD5 (nur das bietet die API) | Jar direkt |
| Fabric, Quilt | Meta-API / Maven | Maven-Prüfsumme des Installers | Server-Launcher-Jar |
| Forge, NeoForge | Maven der Projekte | Maven-Prüfsumme des Installers | Installer mit `--installServer` im Net-Job |
| Java (Temurin) | api.adoptium.net | SHA-256 | entpacken, keine Links |

Die genauen API-Antworten und welche Prüfsummen die Maven-Server je Datei wirklich liefern, prüfe ich beim Bauen jedes Resolvers gegen die echte API (inferiert, noch nicht verifiziert). Wo es nur MD5 oder SHA-1 gibt, zeigt die Oberfläche das ehrlich an.

## Aufgabenliste

Details und Akzeptanzkriterien in `tasks/todo.md`. Jede Phase endet mit grünen Tests (`npm test`) und einem prüfbaren Commit.

### Phase 1: Fundament (ohne sichtbare Änderung)
- [x] 1. Distributionskatalog mit Paper/Folia/Velocity und Vanilla, Tests mit gefälschten APIs
- [x] 2. Purpur, Fabric, Quilt, Forge, NeoForge im Katalog
- [x] 3. Java-Auflösung (Mojang-Java-Version → Temurin-Download mit SHA-256)
- [x] 4. Instanzmodell `lib/instances.js` mit Validierung von `instance.json`

### Checkpoint 1: Katalog und Modell getestet, nichts Bestehendes verändert

### Phase 2: Lebenszyklus
- [ ] 5. Unit-Vorlagen `rconsole-mc@.service`/`.socket`, Starter `bin/mc-launch.js`, polkit-Regel
- [ ] 6. Helper-Jobs `java-install`, `server-create`, `server-install`, `server-delete`
- [ ] 7. `Power` arbeitet pro Instanz; Konsole über FIFO; Autostart durch rconsole
- [ ] 8. API: Instanzen anlegen, installieren, starten, stoppen, löschen (mit Rollen und Audit)

### Checkpoint 2: Server lässt sich per API von null an erstellen und starten (auf einer Debian-VM getestet)

### Phase 3: Oberfläche und Übergang
- [ ] 9. Assistent „Neuer Server“: Distribution, Version, RAM, Port, EULA, Fortschritt live
- [ ] 10. Server-Übersicht mit Start/Stop/Löschen; bestehende Ansichten auf die aktive Instanz
- [ ] 11. Updates für alle Distributionen über den Katalog (ersetzt `lib/paper.js`)
- [ ] 12. „Bestehenden Server übernehmen“ und Installer-Modus ohne vorhandenen Server
- [ ] 13. README, Sicherheitsmodell, Release-Notes

### Checkpoint 3: Code-Review, Security-Review, Ende-zu-Ende auf Debian

## Risiken

| Risiko | Auswirkung | Gegenmaßnahme |
|---|---|---|
| Forge/NeoForge-Installer führt fremden Code aus | Hoch | Läuft nur im gesandboxten `rconsole-net@` als `minecraft`, nur Installer mit geprüfter Prüfsumme von festen Hosts; derselbe Code läuft später ohnehin als Server |
| Purpur nur MD5, Vanilla nur SHA-1 | Mittel | Bezug nur über HTTPS von festen Hosts, schwächere Prüfung in der Oberfläche sichtbar |
| Umbau von `MC_DIR` auf Instanzen bricht bestehende Installationen | Hoch | Externer Modus bleibt Standard für Bestandsinstallationen; die aktive Instanz liefert dieselben Pfade an alle bestehenden Module |
| FIFO-Konsole und SIGTERM-Stopp verhalten sich je Distribution anders | Mittel | Auf Debian je Distribution einmal Ende-zu-Ende testen, RCON-`stop` als Rückfall |
| Viel Speicher durch mehrere JREs und Server | Niedrig | Speicheranzeige pro Instanz, ungenutzte JREs aufräumen |

## Offene Fragen

1. Mehrere Server gleichzeitig (wie Crafty) oder vorerst einer pro rconsole? Empfehlung: Datenmodell und Units sofort mehrfähig, Oberfläche erst mit einem aktiven Server, Umschalter in einer späteren Phase.
2. Soll ich den Velocity-Proxy direkt mit Backend-Servern verbinden (Forwarding-Secret automatisch setzen) oder Velocity zunächst nur als einzelne Instanz anbieten? Empfehlung: zuerst einzeln.
