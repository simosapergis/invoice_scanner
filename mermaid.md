```mermaid
flowchart TD

    %% CLIENT SIDE
    A[User takes photo\n PWA] --> B[Client checks image quality\nresolution, blur, file type]
    B -->|If HEIC/PNG| C[Convert to JPG client-side]
    B -->|If OK| C

    C --> D[Request Signed URL from Cloud Function]
    D --> E[Upload raw file to GCS\nraw-invoices/uploadId/original.jpg]

    E --> F[Return success to app immediately]
    F --> G[App shows 'Processing Invoice' screen]

    %% SERVER SIDE
    E --> H[Cloud Function Trigger:\nonFinalize raw-invoices/...]
    H --> I[Download uploaded file]
    I --> J[Convert to PDF server-side]

    J --> K[Send file to OpenAI API\nOCR + Data Extraction]

    K --> L[Extract supplier data:\nname, VAT, identifiers]

    L --> MDoes supplier exist\nin Firestore?
    M -->|Yes| N[Get supplierId]
    M -->|No| O[Create supplier\ndocument in Firestore]
    O --> N

    N --> P[Create invoiceId]
    P --> Q[Move file:\ncopy raw → suppliers/supplierId/invoices/invoiceId.pdf]
    Q --> R[Delete raw file]

    R --> S[Create invoice document in Firestore]
    S --> T[Send FCM notification: 'Invoice ready']

    T --> U[User opens invoice details screen]