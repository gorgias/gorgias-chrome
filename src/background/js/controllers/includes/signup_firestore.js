gApp.controller('SignupFirestore', function ($timeout) {
    this.iframeUrl = function () {
        return `${Config.websiteUrl}/signup/`;
    };
});
