# Extract Document HTML without sign in

**Beta userscript — version 5.7**

A browser userscript for Rocket Lawyer interview pages. It collects interview field labels as you move through the interview, can advance through sections, closes the registration and Copilot popups at the end, and extracts the generated document as standalone HTML.

## Features

- **Extract and Download as .HTML** — creates a standalone HTML copy of the generated document.
- **Copy+Convert HTML via Pandoc** — copies the document body HTML to the clipboard and opens Pandoc's web app for manual conversion.
- **Auto-advance & Download HTML** — clicks Rocket Lawyer's Continue button through interview sections, caches labels along the way, closes the sign-up dialog and minimizes the Copilot panel, then initiates the HTML download.
- **Interview label cache** — remembers field labels discovered on earlier interview sections in the current browser-tab session.
- **Readable missing-field placeholders** — uses labels such as `[Name of Roommate]` instead of a generic placeholder when the label has been discovered.

## Install

1. Install [Violentmonkey](https://violentmonkey.github.io/) or [Tampermonkey](https://www.tampermonkey.net/).
2. Open the `rocket-lawyer-extract.user.js` file from this repository using its **Raw** view.
3. Your userscript manager should offer to install it. Review the script and choose **Install**.
4. Open a Rocket Lawyer interview page matching `*.rocketlawyer.com/interviews/*` and reload it.

For a GitHub repository, the raw file URL will look like:

`https://raw.githubusercontent.com/OWNER/REPOSITORY/BRANCH/rocket-lawyer-extract.user.js`

Replace `OWNER`, `REPOSITORY`, and `BRANCH` with the actual repository details. Do not use this example URL as-is.

## Use

The script adds three buttons to the lower-right corner of the interview page:

1. **Extract and Download as .HTML** — downloads the currently generated document as HTML.
2. **Copy+Convert HTML via Pandoc** — copies the document body HTML and opens [Pandoc's web app](https://pandoc.org/app/). In Pandoc, paste the text, choose `html` as the input format, and select an output format. DOCX (Word) is recommended; ODT and PDF via Typst are alternatives. The conversion and final download are manual steps on the Pandoc page.
3. **Auto-advance & Download HTML** — advances through sections until Rocket Lawyer's sign-up dialog appears, closes that dialog, minimizes the Copilot chat if present, and initiates the HTML download. Click the purple button again while it is running to request a stop.

The auto-advance feature does not answer interview questions, submit the sign-up form, create an account, or accept Copilot terms. If Rocket Lawyer requires an answer or the page stops advancing, the script stops and displays an error.

## Beta notes and limitations

- This is an independently developed beta userscript, not an official Rocket Lawyer product. Rocket Lawyer may change its page structure or selectors, which can break functionality.
- Labels are learned as interview sections appear. A section that is never visited may have fields without a cached label.
- The label cache uses `sessionStorage` and is scoped to the current tab session. It is not a permanent account-wide store.
- The script searches regular DOM and **open** Shadow DOM. It cannot inspect closed Shadow DOM roots.
- The automatic workflow has a 100-section safety limit and a timeout for sections that do not advance.
- The HTML download is initiated by the browser. Browser download settings determine where the file is saved.
- Pandoc conversion is not automatic: the script copies HTML and opens the Pandoc page, where you choose the format and complete the conversion.
- Review the extracted document before relying on it. This tool is not legal advice and does not verify that the generated document is complete or legally valid.

## Privacy and permissions

The userscript requests no special userscript-manager grants (`@grant none`). It reads the Rocket Lawyer interview/document page in the browser, stores discovered field labels in tab-scoped `sessionStorage`, and creates a local HTML download. The Pandoc button writes the document HTML to the clipboard and opens the Pandoc website; you manually paste the content there. Do not use it on documents you are not authorized to access or export.

## Feedback and bug reports

For a useful bug report, include:

- Browser and userscript manager versions.
- The userscript version.
- Which button you used.
- The exact error notification, if any.
- Relevant console messages from entries beginning with `[RL Extract]`.

Do not include passwords, access tokens, private document contents, or personal information in bug reports.
