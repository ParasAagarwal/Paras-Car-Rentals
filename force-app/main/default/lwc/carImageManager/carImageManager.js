import { LightningElement, api, wire } from "lwc";
import createFile from "@salesforce/apex/carImageController.createFile";
import getCarImages from "@salesforce/apex/carImageController.getCarImages";
import { ShowToastEvent } from "lightning/platformShowToastEvent";
import { notifyRecordUpdateAvailable } from "lightning/uiRecordApi";
import { refreshApex } from "@salesforce/apex";

const TARGET_DIMENSION = 500;
const JPEG_QUALITY = 0.7;

export default class CarImageManager extends LightningElement {
  isPrimaryChecked = true;
  isUploading = false;
  @api recordId;
  @api hideUploadSection = false;

  @wire(getCarImages, {
    productId: "$recordId"
  })
  carImages;

  get hasProductImages() {
    let hasImagesPresent = false;
    if (this.carImages.data && this.carImages.data.length > 0) {
      hasImagesPresent = true;
    }
    return hasImagesPresent;
  }

  handlePrimaryImage(event) {
    this.isPrimaryChecked = event.target.checked;
  }

  async handleFileChange(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) {
      return;
    }

    this.isUploading = true;
    try {
      const { base64, fileName } = await this.resizeAndCompressImage(file);
      await createFile({
        base64Data: base64,
        fileName,
        recordId: this.recordId,
        isPrimaryImage: this.isPrimaryChecked
      });
      this.showToast("Success", "Image Uploaded Successfully", "success");
      //notify the LDS for the update
      await refreshApex(this.carImages);
      await notifyRecordUpdateAvailable([{ recordId: this.recordId }]);
    } catch (error) {
      this.showToast("Error", "Image Upload Failed", "error");
    } finally {
      this.isUploading = false;
      // reset so selecting the same file again still fires onchange
      event.target.value = null;
    }
  }

  // Resizes the image to fit within a 500x500 canvas (preserving aspect
  // ratio, letterboxed on white) and re-encodes it as a compressed JPEG.
  resizeAndCompressImage(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error);
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error("Unable to read image file"));
        img.onload = () => {
          const canvas = document.createElement("canvas");
          canvas.width = TARGET_DIMENSION;
          canvas.height = TARGET_DIMENSION;
          const ctx = canvas.getContext("2d");

          ctx.fillStyle = "#ffffff";
          ctx.fillRect(0, 0, TARGET_DIMENSION, TARGET_DIMENSION);

          const scale = Math.min(
            TARGET_DIMENSION / img.width,
            TARGET_DIMENSION / img.height
          );
          const drawWidth = img.width * scale;
          const drawHeight = img.height * scale;
          const offsetX = (TARGET_DIMENSION - drawWidth) / 2;
          const offsetY = (TARGET_DIMENSION - drawHeight) / 2;
          ctx.drawImage(img, offsetX, offsetY, drawWidth, drawHeight);

          const dataUrl = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
          const base64 = dataUrl.split(",")[1];
          const fileName = file.name.replace(/\.[^.]+$/, "") + ".jpg";
          resolve({ base64, fileName });
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  showToast(title, message, variant) {
    const event = new ShowToastEvent({
      title: title,
      message: message,
      variant: variant
    });
    this.dispatchEvent(event);
  }

  get showUploadSection() {
    return !this.hideUploadSection; //true
  }
}
