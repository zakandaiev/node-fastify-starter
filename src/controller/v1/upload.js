import { replyError, replySuccess } from '#src/service/response.js';
import { createSchema } from '#src/service/schema.js';
import { getPublicFileUrl, uploadFile } from '#src/service/upload.js';

// NORMALIZATION
export const OUTPUT_COLUMNS = ['file'];

// UPLOAD ROUTE
export async function postUpload(request, reply) {
  const data = await request.file();

  const result = await uploadFile(data);
  if (result.status !== 'success') {
    delete result.status;
    return replyError(reply, result);
  }

  return replySuccess(reply, {
    data: getPublicFileUrl(result.uri),
  });
}

export const postUploadSchema = createSchema('upload')
  .body(OUTPUT_COLUMNS, OUTPUT_COLUMNS)
  .defaultResponses()
  .response(200, {
    dataExampleKeys: OUTPUT_COLUMNS,
    dataExampleKeysFormat: 'string',
  })
  .response(400, {
    messageExample: 'File size is too big',
    dataExample: 'FILE_SIZE_IS_INVALID',
    validationExample: [{
      column: 'size',
      operator: 'maxSize',
      operatorValue: 'number in bytes',
    }],
  })
  .meta({
    consumes: ['multipart/form-data'],
    tags: ['Upload', 'v1'],
    summary: 'Upload a file',
    description: 'Uploads a file and returns path to it',
  })
  .build();
