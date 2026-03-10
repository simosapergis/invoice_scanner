# Blue-Green Deployment Guide

## Overview

All Firebase Functions have been migrated to v2 (Gen 2) API with `_v2` suffix for safe blue-green deployment.

## Function Mapping

| Old Function (v1) | New Function (v2) |
|-------------------|-------------------|
| `getSignedUploadUrl` | `getSignedUploadUrl_v2` |
| `processUploadedInvoice` | `processUploadedInvoice_v2` |
| `processInvoiceDocument` | `processInvoiceDocument_v2` |
| `updatePaymentStatus` | `updatePaymentStatus_v2` |
| `updateInvoiceFields` | `updateInvoiceFields_v2` |
| `updateSupplierFields` | `updateSupplierFields_v2` |
| `getSignedDownloadUrl` | `getSignedDownloadUrl_v2` |
| `addFinancialEntry` | `addFinancialEntry_v2` |
| `deleteFinancialEntry` | `deleteFinancialEntry_v2` |
| `getFinancialReport` | `getFinancialReport_v2` |
| `addRecurringExpense` | `addRecurringExpense_v2` |
| `updateRecurringExpense` | `updateRecurringExpense_v2` |
| `processRecurringExpenses` | `processRecurringExpenses_v2` |
| `getRecurringExpenses` | `getRecurringExpenses_v2` |

## Deployment Steps

### Step 1: Deploy v2 Functions

```bash
cd functions
firebase deploy --only functions
```

This will deploy all v2 functions **alongside** your existing v1 functions. Both versions will run simultaneously.

### Step 2: Test v2 Functions

Test each v2 function endpoint. The URLs will be:

```
https://{region}-{project-id}.cloudfunctions.net/{functionName}_v2
```

For example:
- Old: `https://europe-west3-clean-abacus-482115-a1.cloudfunctions.net/updatePaymentStatus`
- New: `https://europe-west3-clean-abacus-482115-a1.cloudfunctions.net/updatePaymentStatus_v2`

**Testing checklist:**
- [ ] Test `getSignedUploadUrl_v2` - Upload invoice PDF
- [ ] Test `processUploadedInvoice_v2` - Verify storage trigger works
- [ ] Test `processInvoiceDocument_v2` - Verify Firestore trigger works
- [ ] Test `updatePaymentStatus_v2` - Update payment status
- [ ] Test `updateInvoiceFields_v2` - Edit invoice fields
- [ ] Test `updateSupplierFields_v2` - Edit supplier fields
- [ ] Test `getSignedDownloadUrl_v2` - Download invoice PDF
- [ ] Test `addFinancialEntry_v2` - Add income/expense
- [ ] Test `deleteFinancialEntry_v2` - Soft delete entry
- [ ] Test `getFinancialReport_v2` - Get financial report
- [ ] Test `addRecurringExpense_v2` - Add recurring expense
- [ ] Test `updateRecurringExpense_v2` - Update recurring expense
- [ ] Test `getRecurringExpenses_v2` - List recurring expenses
- [ ] Test `processRecurringExpenses_v2` - Wait for scheduled run or trigger manually

### Step 3: Update Client Code

Update your frontend/client to use the new v2 function URLs. Update all function calls:

```javascript
// Before
const functionUrl = 'https://europe-west3-clean-abacus-482115-a1.cloudfunctions.net/updatePaymentStatus';

// After
const functionUrl = 'https://europe-west3-clean-abacus-482115-a1.cloudfunctions.net/updatePaymentStatus_v2';
```

Or better yet, use a config/environment variable:

```javascript
const FUNCTION_VERSION = process.env.REACT_APP_FUNCTION_VERSION || '_v2';
const functionUrl = `https://europe-west3-clean-abacus-482115-a1.cloudfunctions.net/updatePaymentStatus${FUNCTION_VERSION}`;
```

### Step 4: Monitor & Verify

Monitor the v2 functions for 24-48 hours:
- Check Firebase Console → Functions → Logs
- Verify no errors
- Confirm all features work correctly
- Check performance metrics

### Step 5: Delete Old v1 Functions

Once you're confident the v2 functions work correctly:

```bash
# List all functions
firebase functions:list

# Delete old v1 functions one by one
firebase functions:delete getSignedUploadUrl
firebase functions:delete processUploadedInvoice
firebase functions:delete processInvoiceDocument
firebase functions:delete updatePaymentStatus
firebase functions:delete updateInvoiceFields
firebase functions:delete updateSupplierFields
firebase functions:delete getSignedDownloadUrl
firebase functions:delete addFinancialEntry
firebase functions:delete deleteFinancialEntry
firebase functions:delete getFinancialReport
firebase functions:delete addRecurringExpense
firebase functions:delete updateRecurringExpense
firebase functions:delete processRecurringExpenses
firebase functions:delete getRecurringExpenses
```

Or delete all at once (use with caution):

```bash
firebase functions:delete getSignedUploadUrl processUploadedInvoice processInvoiceDocument updatePaymentStatus updateInvoiceFields updateSupplierFields getSignedDownloadUrl addFinancialEntry deleteFinancialEntry getFinancialReport addRecurringExpense updateRecurringExpense processRecurringExpenses getRecurringExpenses
```

### Step 6: Rename v2 Functions (Optional)

If you want to remove the `_v2` suffix after deleting v1 functions:

1. In `functions/index.js`, rename all exports:
   ```javascript
   // Change this:
   exports.updatePaymentStatus_v2 = onRequest(...)
   
   // Back to:
   exports.updatePaymentStatus = onRequest(...)
   ```

2. Deploy again:
   ```bash
   firebase deploy --only functions
   ```

3. Update client code to remove `_v2` suffix from URLs

## Rollback Plan

If v2 functions have issues:

1. **Immediate rollback**: Update client to point back to v1 function URLs
2. **Fix issues**: Debug and fix the v2 functions
3. **Redeploy v2**: Deploy fixed v2 functions
4. **Retry**: Update client to use v2 again

## Key Differences: v1 vs v2

| Feature | v1 (Gen 1) | v2 (Gen 2) |
|---------|------------|------------|
| **CORS** | Manual headers | Automatic with `cors: true` |
| **Region** | `.region(REGION)` | `region: REGION.value()` in options |
| **Service Account** | `.runWith({ serviceAccount })` | `serviceAccount` in options |
| **Environment Variables** | `functions.config()` or `process.env` | `defineString()` params |
| **Storage Trigger** | `.storage.object().onFinalize(object)` | `onObjectFinalized(event)` - access via `event.data` |
| **Firestore Trigger** | `.firestore.document().onWrite(change, context)` | `onDocumentWritten(event)` - access via `event.data`, `event.params` |
| **Scheduled** | `.pubsub.schedule().onRun()` | `onSchedule(event)` with schedule in options |
| **HTTP** | `.https.onRequest(req, res)` | `onRequest(req, res)` with options |

## Environment Variables

Ensure your `functions/.env` file contains:

```env
SERVICE_ACCOUNT_EMAIL=firebase-adminsdk-fbsvc@clean-abacus-482115-a1.iam.gserviceaccount.com
REGION=europe-west3
OPENAI_API_KEY=sk-proj-...
GCS_BUCKET=clean-abacus-482115-a1.appspot.com
```

## Troubleshooting

### Issue: "Missing required parameters"
**Solution**: Ensure `.env` file exists in `functions/` directory with all required variables

### Issue: "CORS errors"
**Solution**: Gen 2 handles CORS automatically with `cors: true`. If you still see errors, check that the client is sending proper Origin headers

### Issue: "Function not found"
**Solution**: Make sure you deployed the functions successfully. Check Firebase Console → Functions

### Issue: "Storage/Firestore triggers not firing"
**Solution**: For blue-green deployment, triggers use the same path/bucket, so only one version should be active. Consider disabling the v1 trigger before enabling v2, or use different trigger paths/buckets

### Issue: "Scheduled function running twice"
**Solution**: Delete the old v1 scheduled function immediately after deploying v2 to avoid duplicate runs

## Notes

- **Firestore/Storage Triggers**: Both v1 and v2 triggers will fire for the same events during blue-green deployment. Consider temporarily disabling v1 triggers or carefully monitoring for duplicate processing
- **Scheduled Functions**: Both versions will run on schedule. Delete v1 scheduled function immediately after v2 deployment
- **HTTP Functions**: Safe for blue-green - no conflicts since they have different URLs
- **Cost**: Running duplicate functions temporarily increases costs. Complete migration quickly

