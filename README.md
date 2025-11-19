# invoice_scanner
Scan invoices and extract fields using OCR.

## Prerequisites
- Node.js 18+ installed
- An OpenAI API key with access to GPT-4o / Responses API

## macOS / Linux
### Installation
```bash
npm install
```

### Usage
```bash
export OPENAI_API_KEY=sk-...
npm run invoice:ocr                 # uses invoice.JPG
# or OCR a specific file
node invoice_ocr.js my_invoice.pdf
```

The script uploads the invoice to GPT-4o, performs OCR in Greek, and prints the requested fields plus an `ΑΚΡΙΒΕΙΑ` confidence percentage. Uncomment the schema block in `invoice_ocr.js` if you want to enforce JSON output strictly.

## Windows (PowerShell)
### Installation
```powershell
npm install
```

### Usage
```powershell
$env:OPENAI_API_KEY = "sk-..."
npm run invoice:ocr                 # uses invoice.JPG
# or OCR a specific file
node invoice_ocr.js .\my_invoice.pdf
```
