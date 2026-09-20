# File Share

Upload a file under a piece of text; anyone who enters that text on any browser can download it.
Files are deleted 3 days after upload. Node/Express backend, same front end style as the clipboard project.

## Run locally

    npm install
    npm start          # http://localhost:8080, files stored in ./data

## Deploy to GCP (Cloud Run + Cloud Storage)

    gcloud storage buckets create gs://YOUR-BUCKET --location=REGION
    gcloud storage buckets update gs://YOUR-BUCKET --lifecycle-file=infra/lifecycle.json
    gcloud run deploy fileshare --source . --region REGION --allow-unauthenticated \
      --set-env-vars BUCKET=YOUR-BUCKET

The Cloud Run service account needs `roles/storage.objectAdmin` on the bucket.

## Notes

- The bucket lifecycle rule (`infra/lifecycle.json`) deletes objects at 3 days; GCS runs it lazily, so the
  server also refuses and removes anything older than 3 days.
- Max file size is 25 MB (Cloud Run's request limit is 32 MB).
- A text can hold one file at a time; uploading to a text that is still in use returns 409.
