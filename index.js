// Extract PDF text including ALL form field values
async function extractPdfText(buffer) {
  let text = '';
  
  // Regular pdf-parse for main text
  try {
    const parsed = await pdf(buffer);
    text = parsed.text;
  } catch (e) {
    console.log('pdf-parse failed:', e.message);
  }

  // Extract ALL annotations and form fields
  try {
    const data = new Uint8Array(buffer);
    const doc = await getDocument({ data }).promise;
    
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const annotations = await page.getAnnotations();
      
      console.log('Page', i, 'annotations:', annotations.length);
      
      for (const annot of annotations) {
        // Log all annotations to see what we're getting
        console.log('Annotation:', annot.fieldType, annot.fieldName, annot.fieldValue, annot.contents);
        
        // Get field value (fillable form fields)
        if (annot.fieldValue) {
          text += '\n[FIELD ' + (annot.fieldName || '') + ': ' + annot.fieldValue + ']';
        }
        
        // Get contents (text annotations, comments)
        if (annot.contents) {
          text += '\n[ANNOTATION: ' + annot.contents + ']';
        }
        
        // Get alternate text
        if (annot.alternativeText) {
          text += '\n[ALT: ' + annot.alternativeText + ']';
        }
      }
    }
  } catch (e) {
    console.log('pdfjs extraction failed:', e.message);
  }

  console.log('Total extracted text length:', text.length);
  return text;
}
