```mermaid
flowchart TD
  %% CLIENT SIDE
  A1[User Takes Photo in PWA] --> A2[Image File Received]

  subgraph Client_Side[Client-Side Processing PWA]
    A2 --> A3[Detect Format]
    A3 -->|If HEIC/PNG/WebP| A4[Convert to JPEG Canvas / heic2any fallback]
    A3 -->|If JPEG| A5[Skip Conversion]

    A4 --> A6[Quality Checks]
    A5 --> A6[Quality Checks]

    subgraph Quality_Checks[Quality Checks]
      A6a[Resolution Check] --> A6b[Blur Detection] --> A6c[Brightness Check]
    end

    A6 -->|If fails| A7[Prompt user to retake photo]
    A6 -->|If OK| A8[Request Signed URL from Backend]
  end

  A8 --> A9[Upload JPEG to GCS via Signed URL]
  A9 --> A10[GCS stores raw image]

  %% BACKEND SIDE
  A10 --> B1[GCS Finalize Event Trigger]

  subgraph Cloud_Run_Worker[Cloud Run Worker Serverless Async Pipeline]
    B1 --> B2[Load JPEG from GCS]
    B2 --> B3[Send Image to OpenAI OCR/Extraction]
    B3 --> B4[Extract Structured Invoice Data]
    B4 --> B5[Save to Firestore: status='completed', pdfStatus='pending']
    B5 --> B6[Send FCM Notification: 'Invoice Processed']

    B4 --> B7[Async: Start PDF Generation Job]
    B7 --> B8[Generate PDF from Original JPEGs]
    B8 --> B9[Upload PDF to GCS]
    B9 --> B10[Update Firestore: pdfStatus='completed']
  end

  %% FIRESTORE & NOTIFICATIONS
  B6 --> C1[Firestore Document Updated]
  B10 --> C1

  subgraph Firestore[Firestore State Machine]
    C1 -->|status='pending'| C2[UI: Processing Spinner]
    C1 -->|status='completed'| C3[UI: Show Extracted Data]
    C1 -->|pdfStatus='completed'| C4[UI: PDF Ready for Download]
    C1 -->|status='error'| C5[UI: Retry or Reupload]
  end

  C1 --> D1[FCM Push Notification to PWA]

  %% UX
  D1 --> E1[PWA Updates UI in Real Time]