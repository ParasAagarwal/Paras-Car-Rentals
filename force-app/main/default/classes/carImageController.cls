public with sharing class carImageController {
   
    // base64Data is expected to already be resized/compressed (500x500 JPEG)
    // by the caller -- see carImageManager.resizeAndCompressImage.
    @AuraEnabled
    public static void createFile(
        String base64Data,
        String fileName,
        String recordId,
        Boolean isPrimaryImage
    ){
        try {
            ContentVersion contentVersion = new ContentVersion();
            contentVersion.Title = fileName;
            contentVersion.PathOnClient = fileName;
            contentVersion.VersionData = EncodingUtil.base64Decode(base64Data);
            insert contentVersion;

            //insert record in carImage
            Car_Image__c carImage = new Car_Image__c(
                Car__c = recordId,
                Image_Url__c =  '/sfc/servlet.shepherd/version/download/' + contentVersion.Id
            );
            if(isPrimaryImage){
                carImage.Primary_Image__c = true;
            }
            insert carImage;
        } catch (Exception ex) {
            System.debug(ex.getMessage());
            Log logger = Log.get();
            logger.publish(ex.getMessage());
            throw new AuraHandledException('Failed to upload image: ' + ex.getMessage());
        }
    }

      @AuraEnabled(cacheable=true)
  public static List<Car_Image__c> getCarImages(Id productId) {
    try {
      return [
        SELECT id, Car__r.Name, Image_Url__c, Primary_Image__c
        FROM Car_Image__c
        WHERE Car__c = :productId
        WITH USER_MODE
      ];
    } catch (Exception e) {
      throw new AuraHandledException(e.getMessage());
    }
  }
}