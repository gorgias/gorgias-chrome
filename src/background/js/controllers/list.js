gqApp.controller('ListCtrl',
    function ($scope, $rootScope, $routeParams, $location, $timeout, $filter, QuicktextService, SettingsService, ProfileService, StatsService) {

        var $formModal;

        $scope.filteredQuicktexts = [];
        $scope.quicktexts = [];
        $scope.tags = [];
        $scope.filterTags = [];
        $scope.limitQuicktexts = 42; // I know.. it's a cliche

        // by default the load more button is disabled
        $('.load-more').hide();

        $scope.reloadQuicktexts = function (remotePromise) {
            QuicktextService.quicktexts().then(function (r) {
                $scope.quicktexts = r;
            });

            QuicktextService.allTags().then(function (r) {
                $scope.tags = r;
            });

            // This is executed if a remote operation on the server was performed
            if (remotePromise) {
                remotePromise.then(function () {
                    $scope.reloadQuicktexts();
                });
            }
        };
        $scope.reloadQuicktexts();

        // Setup recuring syncing interval
        this.syncInterval = null;
        this.sync = function () {
            window.clearInterval(this.syncInterval);
            QuicktextService.sync(function () {
                $scope.reloadQuicktexts();
            });
        };
        this.sync(); // sync right now
        this.syncInterval = window.setInterval(this.sync, 15000); // every 15 seconds


        $scope.$watch('quicktexts', function () {
            if ($scope.quicktexts && $scope.quicktexts.length) {
                // trigger filterQuicktexts to update filtered quicktexts
                filterQuicktexts();
            }
        });

        // Listen on syncing events
        $scope.$on("quicktexts-sync", function () {
            $scope.reloadQuicktexts();
        });


        /* Init modal and other dom manipulation
         * when the templates have loaded
         */
        var initDom = function () {

            /* New/Edit modal
             */
            $formModal = $('.quicktext-modal');
            $formModal.modal({
                show: false
            });

            $formModal.on('hide.bs.modal', function (e) {
                $timeout(function () {
                    $location.path('/list').search({});
                });
            });

            checkRoute();

        };

        $rootScope.$on('$includeContentLoaded', initDom);

        // Show the form for adding a new quicktext or creating one
        $scope.showForm = function (id) {
            _gaq.push(['_trackEvent', 'forms', 'show']);

            var defaults = {
                'id': '',
                'remote_id': '',
                'subject': '',
                'shortcut': '',
                'title': '',
                'tags': '',
                'body': ''
            };

            if ($routeParams.id === 'new') {
                // new qt
                $scope.selectedQt = angular.copy(defaults);
                $scope.selectedQt.body = $routeParams.body;
            } else if ($routeParams.id) {
                // update qt
                QuicktextService.get($routeParams.id).then(function (r) {
                    $scope.selectedQt = angular.copy(r);
                });
            }

            $formModal.modal('show');
        };

        /* Check search params to see if adding or editing items
         */
        var checkRoute = function () {

            // if not the default list
            // new or edit, so show the modal
            if ($routeParams.id) {
                $scope.showForm();
            }

        };

        $scope.$on('$routeUpdate', checkRoute);

        $scope.loadMore = function () {
            $scope.limitQuicktexts += 42;
            if ($scope.limitQuicktexts > $scope.filteredQuicktexts.length) {
                $(".load-more").hide();
                $scope.limitQuicktexts = 42;
            }
        };
        // Delete a quicktext. This operation should first delete from the localStorage
        // then it should imedially go to the service and delete on the server
        $scope.deleteQt = function () {
            QuicktextService.delete(this.quicktext).then(function (remotePromise) {
                $scope.reloadQuicktexts(remotePromise);
            });
        };


        // Save a quicktext, perform some checks before
        $scope.saveQt = function () {
            if (!$scope.selectedQt.title) {
                alert("Please enter a Title");
                return false;
            }

            if (!$scope.selectedQt.body) {
                alert("Please enter a Quicktext Template");
                return false;
            }

            if ($scope.selectedQt.id) {
                QuicktextService.update($scope.selectedQt).then(function (remotePromise) {
                    $scope.reloadQuicktexts(remotePromise);
                });
            } else {
                QuicktextService.create($scope.selectedQt).then(function (remotePromise) {
                    $scope.reloadQuicktexts(remotePromise);
                });
            }

            // hide teh modal
            $('.modal').modal('hide');
        };

        // Save a quicktext, perform some checks before
        $scope.duplicateQt = function () {
            if (!$scope.selectedQt.title) {
                alert("Please enter a Title");
                return false;
            }

            if (!$scope.selectedQt.body) {
                alert("Please enter a Quicktext Template");
                return false;
            }

            QuicktextService.create($scope.selectedQt).then(function (remotePromise) {
                $scope.reloadQuicktexts(remotePromise);
            });

            // hide teh modal
            $('.modal').modal('hide');

        };

        $scope.toggleFilterTag = function () {
            var index = $scope.filterTags.indexOf(this.tag);
            if (index === -1) {
                $scope.filterTags.push(this.tag);
            } else {
                $scope.filterTags.splice(index, 1); // remove from tags
            }
        };

        /* Keyboard navigation
         */
        var KEY_ENTER = 13,
            KEY_UP = 38,
            KEY_DOWN = 40;

        $scope.focusIndex = 0;

        // key navigation
        $scope.keys = [];
        $scope.keys.push({
            code: KEY_ENTER,
            action: function () {
                // activate the enter key action only
                // if there are no modals visible
                // and the existing search filter matches any items

                var modalVisible = $('.modal').is(':visible');

                if (!modalVisible && $scope.filteredQuicktexts.length) {
                    // get the id of the currently selected quicktext
                    var quicktextId = $scope.filteredQuicktexts[$scope.focusIndex].id;
                    $scope.activateQuicktext(quicktextId);
                }
            }
        });

        $scope.keys.push({
            code: KEY_UP,
            action: function () {
                if ($scope.focusIndex > 0) {
                    $scope.focusIndex--;
                    $scope.scroll();
                }
            }
        });

        $scope.keys.push({
            code: KEY_DOWN,
            action: function () {
                if ($scope.focusIndex + 1 < $scope.filteredQuicktexts.length) {
                    $scope.focusIndex++;
                    $scope.scroll();
                }
                ;
            }
        });

        $scope.$on('keydown', function (msg, code) {
            $scope.keys.forEach(function (o) {
                if (o.code !== code) {
                    return;
                }
                o.action();
                $scope.$apply();
            });
        });

        /* Scroll to the focused element
         */
        $scope.scroll = function () {
            var scrollContainer = $("#quicktext-table-container");
            var active = $('.active');
            scrollContainer.scrollTop(
                    active.offset().top - scrollContainer.offset().top + scrollContainer.scrollTop()
            );
        };

        // apply filters to the list of quicktexts
        var filterQuicktexts = function () {
            // apply the text search filter
            $scope.filteredQuicktexts = $filter('filter')($scope.quicktexts, $scope.searchText);
            // apply the tag serach filter
            $scope.filteredQuicktexts = $filter('tagFilter')($scope.filteredQuicktexts, $scope.filterTags);

            $scope.focusIndex = 0;

            if ($scope.filteredQuicktexts.length < $scope.limitQuicktexts) {
                $('.load-more').hide();
                $scope.limitQuicktexts = 42;
            } else {
                $('.load-more').show();
            }
        };

        $scope.$watch('searchText', filterQuicktexts);
        $scope.$watch('filterTags', filterQuicktexts, true);

        /* Insert quicktext from the pageAction popup
         */
        $scope.insertQuicktext = function (quicktextId) {
            // get the quicktext id
            _gaq.push(['_trackEvent', 'popup', 'insert']);

            // getch the quicktext
            QuicktextService.get(quicktextId).then(function (quicktext) {
                chrome.tabs.query({active: true, currentWindow: true}, function (tabs) {
                    chrome.tabs.sendMessage(tabs[0].id, {
                        'action': 'insert',
                        'quicktext': quicktext
                    }, function (response) {
                        //console.log(response);
                    });
                    window.close();
                });
            });
        };

        /* Activate quicktext on click or Enter key
         */
        $scope.activateQuicktext = function (id) {
            if ($rootScope.pageAction) {
                $scope.insertQuicktext(id);
            } else {
                $location.search('id', id);
            }
            ;

            return false;
        };

        /* Set active item based on focus rather than keyboard
         */
        $scope.setFocus = function (index) {
            $scope.focusIndex = index;
        };
    });
