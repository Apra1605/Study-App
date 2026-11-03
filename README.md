# Studyspace

A static personal study website with Firebase Authentication, Realtime Database sync, browser-only Google Drive PowerPoint import, Realtime Database presentation indexing, subject-aware Groq tutoring, and practice tools. It is designed to run on GitHub Pages with no app server or build step.

## Publish on GitHub Pages

The included GitHub Actions workflow publishes the static HTML, CSS, and JavaScript files whenever you push to `main` or `master` (or run it manually from Actions). In the repository, open **Settings → Pages** and set **Build and deployment → Source** to **GitHub Actions**. The first deployment will show the Pages URL in the Actions run.

## Firebase setup

The web app is configured for the Firebase project provided for Studyspace. In Firebase Console, enable **Authentication → Google** and add `localhost` plus your GitHub Pages hostname under **Authentication → Settings → Authorized domains**. The `firebase.js` file contains the public web-app configuration; it does not contain an admin credential.

Study data is stored at `users/{uid}/study`. The included Realtime Database rules restrict each account to its own UID path. To publish the rules, run `npx firebase-tools login` once, then `npx firebase-tools deploy --only database --project study-app-820dc`, or paste `database.rules.json` into Realtime Database **Rules** in Firebase Console. Database access will be denied until these rules are published. Firebase Auth must also have Google enabled.

Firebase Authentication secures each account, and Realtime Database stores each learner study state at `users/{uid}/study`. The app listens for database changes so signed-in devices stay up to date. Existing local-only profiles are not automatically imported into Firebase.

To enable AI, open **Settings** in the app and enter your own Groq API key. It is kept in the current browser tab's session storage and sent directly from that browser to Groq. This applies both to GitHub Pages and static previews; the app does not call a same-origin AI API. A browser-side key can be inspected or used by anyone who has access to that browser session, so use a dedicated key with spending limits and remove it when done. Never put a Groq key in the repository, the workflow, or app source. For a public multi-user site that needs a shared AI service, a separate backend or serverless function can protect the key.

The Pages workflow copies the HTML, JavaScript modules, CSS, and icon into a static artifact. AI requests, including whiteboard vision annotations, document summaries, and chat, go directly from the browser to Groq using the key entered in Settings. The key stays in that tab's session storage. Firebase handles Google sign-in and study data sync. No Node server is part of the Pages deployment. Firebase web-app configuration is public; database access is restricted by the included UID-based security rules.

## Google Drive PowerPoint import

The Study materials page includes Google Picker for one or more `.pptx` files. Each selected file can be assigned to a subject. Studyspace requests the limited Google `drive.file` permission, reads the chosen PPTX from Drive, and parses its Office XML in a browser Web Worker. The original stays where it is; Studyspace creates a Drive shortcut and saves structured extracted text and an AI study guide in its own subject folders.

The importer extracts slide titles and text, tables, speaker notes, chart labels, and available image alt-text descriptions. It does not OCR slide screenshots or raster images. Extracted slide chunks, import progress, AI section summaries, presentation overview, and topic indexes are stored in Realtime Database under the signed-in user's UID at `users/{uid}/driveDocuments/{documentId}` and `users/{uid}/driveDocumentData/{documentId}`, so the same account can use them across devices. IndexedDB stores only a temporary copy of the original PowerPoint while extraction is unfinished, so the import can resume on that browser; that blob is deleted after extraction completes. Processing only runs while the site is open. The original PowerPoint remains in Google Drive. Previously indexed Firestore records are not copied automatically; reimport those presentations to place them in Realtime Database. The AI tutor, quiz/exam generator, flashcards, and knowledge map use those synced materials with slide citations.

Configure Google Cloud once before using the picker:

1. In Google Cloud project `729887055897` (the project for the configured OAuth client and Picker key), enable **Google Drive API** and **Google Picker API**. Firebase authentication and Realtime Database use project `study-app-820dc` (`210283172036`).
2. The OAuth web client ID, Picker API key, and Picker project number are fixed in `drive-client.js`; there are no setup inputs in the website. In Google Cloud, authorize the local development origin (for example `http://localhost:3000`) and the GitHub Pages origin (`https://YOUR-ACCOUNT.github.io`). Add any custom domain too. Do not create or put an OAuth client secret in this frontend.
3. Restrict the configured Google API key to **Google Picker API** and **Google Drive API**. For website restrictions, allow your local origin, GitHub Pages/custom-domain origin, and `https://docs.google.com/*` for the Picker iframe.
4. Configure the OAuth consent screen. During testing, add your Google account as a test user if the app is in Testing mode.
5. Publish the supplied `database.rules.json` to Firebase Realtime Database (the same UID-scoped rules protect both study state and presentation data).
6. Open Study materials, click **Import from Google Drive**, and authorize the same Google account used for Firebase sign-in.
7. Add a Groq key in Settings if you want automatic slide summaries, a presentation overview, and a study guide. Extraction and Drive text export work even when AI analysis is paused or no key is configured. AI requests are bounded and rate-limited; completed sections are cached and can resume.

The OAuth client ID and API key are public browser identifiers and are stored in this browser's local storage. OAuth access tokens stay in memory and are not saved. Google account consent can be revoked in Google Account security settings. The selected file and generated exports are never made public by this app.

Drive import uses browser storage and memory, so available storage, browser support, Drive quotas, and the selected deck's size affect processing. The ZIP index and one XML entry at a time are read; slide images are not rendered or decompressed. ZIP64/encrypted presentations, older `.ppt` files, and image OCR are not supported. The app reports these cases and preserves completed checkpoints.

Tutor and whiteboard prompts are screened with `meta-llama/llama-prompt-guard-2-22m`. This is a prompt-attack classifier, not a conversational tutor, so `GROQ_MODEL` remains the text-generation model that writes study answers.

## Implemented

- Firebase Google sign-in and per-user Realtime Database study spaces.
- Six subject workspaces, renaming, and adding subjects.
- Persistent subject notes, text/Markdown/CSV study files, and conversation history.
- Google Drive Picker import for PPTX files, per-subject Drive folders, structured slide text exports, Realtime Database import checkpoints, slide text, and hierarchical AI analysis.
- Groq tutoring with prompt screening and simple, standard, detailed, step-by-step, and Socratic modes.
- Rich AI message formatting, including Markdown and rendered LaTeX math (fractions, roots, equations, and display math) via KaTeX; a readable text fallback is used if the renderer cannot load.
- Note retrieval by word overlap to include a small set of relevant passages in tutor and generation requests.
- AI multiple-choice quizzes, scoring, explanations, mistake journal, and adaptive difficulty based on the last three quiz results.
- AI flashcards with a small spaced-review interval schedule.
- Timed multiple-choice practice exams.
- Blackboard canvas with chalk, marker, highlighter, pencil, glow pen, color palette, opacity and size controls, shapes, text, undo/redo, and filled-shape options; separate persistent student and AI layers, teacher annotations, PNG export, and docked chat.
- Topic mastery estimates derived from submitted quiz answers, plus progress summaries, activity history, and JSON backup export.

## Current boundaries

Firebase provides cloud authentication and database storage. Study materials and conversations are available to the signed-in account across devices.

The static app uses `qwen/qwen3.8-27b` for tutor and vision responses, and `meta-llama/llama-prompt-guard-2-22m` to screen chat prompts. Groq model availability can vary by account; see the [model](https://console.groq.com/docs/models) and [vision](https://console.groq.com/docs/vision) documentation.


