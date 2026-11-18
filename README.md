# VirtuStream Browser

Navigateur Windows (Electron/Chromium) avec onglets verticaux, favoris, téléchargements,
zoom, outils de développement, et une vidéo locale utilisée comme **caméra virtuelle dans les
pages ouvertes dans ce navigateur** (WhatsApp Web, Meet, Zoom Web, Messenger, etc.).

## Ce que fait (et ne fait pas) la caméra virtuelle
- Fait : quand une page demande la caméra, elle reçoit le flux de la vidéo choisie.
- Ne fait pas : elle n'apparaît **pas** comme périphérique Windows pour d'autres logiciels
  (Zoom desktop, Teams…). Cela demande un pilote natif (Media Foundation), non inclus ici.
- Le micro reste votre micro réel. Aucune piste audio de la vidéo n'est envoyée.
- Une vidéo 1080p reste en 1080p (flux direct) ; on ne l'agrandit jamais. Ce que le site
  destinataire transmet réellement dépend de sa propre compression.

## Utilisation
- Bouton caméra (en haut à droite) ou Ctrl+Maj+V : choisir une vidéo (mp4, webm, mov, mkv…).
- Bouton pause/lecture ou Ctrl+Maj+P : fige ou relance la vidéo.
- Changer de vidéo pendant un appel : elle est remplacée à chaud, sans recharger la page.
- Menu caméra : boucle, résolution de sortie (native / 720p max / 480p max), 15-24-30 images/s,
  statistiques en direct (résolution, FPS mesurés, images perdues, RAM, CPU, décodage GPU).
- Chaque site doit être autorisé une première fois (caméra/micro) ; choix mémorisable.
- Raccourcis : Ctrl+T, Ctrl+W, Ctrl+Tab, Ctrl+L, Ctrl+D, Ctrl+R, F12, Ctrl +/-/0, Alt+←/→,
  Ctrl+Maj+E (panneau d'onglets), Ctrl+Maj+B (barre de favoris).

## Légèreté (PC à 4 Go de RAM)
- Aucune vidéo n'est décodée tant qu'une page n'utilise pas la caméra ; tout est libéré ~4 s
  après l'arrêt de la caméra.
- Onglets inactifs mis en veille (3 min en mode économique, 10 min sinon). Jamais en veille :
  onglet audible, caméra utilisée, ou site auquel caméra/micro a été accordé (appels, messageries).
- Mode économique activé automatiquement sous ~6 Go de RAM (modifiable dans le menu ⋮).

## Lancer en local
    npm install
    npm start

## Compiler (installateur Windows)
Poussez le dossier sur GitHub (branche main) : l'onglet Actions produit l'installateur `.exe`
et la version portable (Artifacts). Ou en local sous Windows : `npm run dist` (dossier `dist/`).
L'installateur ne demande pas de droits administrateur (installation par utilisateur).
Désinstallation : Paramètres Windows > Applications > VirtuStream Browser.

Note : le nom de l'application a changé ; la configuration (favoris, vidéo) de l'ancienne version
« Camera Browser » n'est pas reprise automatiquement.

Usage prévu : tests, démos, streaming. Ne pas utiliser pour tromper des interlocuteurs ni
contourner une vérification d'identité.
