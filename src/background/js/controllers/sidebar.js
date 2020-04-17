import amplitude from '../utils/amplitude';

export default function SidebarCtrl ($scope, $location, $window,
                                         AccountService, SettingsService, TemplateService, FilterTagService) {
    'ngInject';
    $scope.profile = {};
    $scope.filterTags = [];
    $scope.account = {
        info: {},
        current_subscription: {}
    };

    $window.addEventListener('message', function (e) {
        if (e.data == "gorgias-signedup-reload") {
            location.reload(true);
        }
    });

    // setup account
    function loadAccount() {
        SettingsService.get("isLoggedIn").then(function (isLoggedIn) {
            if (!isLoggedIn) {
                return;
            }

            AccountService.get().then(function (account) {
                $scope.account = account;
            });
        });
    }

    loadAccount();

    // gather tags
    function loadTags() {
        TemplateService.allTags().then(function (r) {
            var tags = [];

            for (var t in r) {
                tags.push({name: t, count: r[t]});
            }
            tags.sort(function (a, b) {
                var aName = a.name.toLowerCase();
                var bName = b.name.toLowerCase();
                if (aName < bName)
                    return -1;
                if (aName > bName)
                    return 1;
                return 0;
            });
            $scope.tags = tags;
        });
    }

    loadTags();

    $scope.toggleFilterTag = FilterTagService.toggleFilterTag;
    $scope.emptyFilterTags = FilterTagService.emptyFilterTags;



    $scope.trackSettings = function(isLoggedIn) {
        amplitude.getInstance().logEvent("Opened Settings", {
            'isLoggedIn': isLoggedIn
        });
    };

    // event listeners
    $scope.$on('toggledFilterTag', function () {
        $scope.filterTags[0] = FilterTagService.filterTags[0];

        if ($scope.filterTags[0] != undefined) {
            $location.path('/list/tag');
        }
    });

    $scope.$on('reload', function () {
        loadTags();
        loadAccount();
    });

    $scope.isFree = function () {
        return (
            !$scope.account.info.name ||
            $scope.account.current_subscription.plan === 'free' ||
            $scope.account.current_subscription.active === false
        );
    };
}
