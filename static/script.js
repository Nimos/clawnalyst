var pending = false;
var socket;

var feralID = 0;

$(document).ready(function () {
    $("input#link").keyup(function () {
        var pattern = /https?:\/\/www\.warcraftlogs\.com\/reports\/([0-9A-z]*)/
        var sourcePattern = /https?:\/\/www\.warcraftlogs\.com\/reports\/.*\#.*(source=([0-9]*)).*/
        var fightPattern = /https?:\/\/www\.warcraftlogs\.com\/reports\/.*\#.*(fight=([0-9]*)).*/

        var match = pattern.exec(this.value);
        if (match) var logID = match[1];

        var match = sourcePattern.exec(this.value);
        if (match) var sourceIndex = match[2];

        var match = fightPattern.exec(this.value);
        if (match) var fightIndex = match[2];

        if (logID) {
            hideLinkError();
            if (pending) return;
            pending = true;
            setTimeout("pending=false", 1000);
            $.post("/validate", {code: logID, fight: fightIndex, source: sourceIndex}, function (r) {
                pending = false;
                if (r == "ERROR") {
                    showLinkError();
                } else {
                    startLoadScreen(r);
                }
            });
        } else {
            showLinkError()
        }
    })
});

var startLoadScreen = function(uID) {
     socket = io();
     socket.on("message", function(message) {
        $('pre').show();
        $('.loadstatus pre').prepend(message+"\n");
        if(message.startsWith("DONE!")) {
            $('.welcome').fadeOut(function () {
                location.href="/"+uID+'_'+feralID+".html";
            })
        }
        console.log(message);
     });
     socket.on("selection", function(list) {
        $('.modal div').html("");
        for (id in list) {
            $('.modal div').append("<a href='#'' onclick='select("+id+")'>"+list[id]+"</a>")
        }
        $('.modal').show();
     });
     socket.emit("attach", {uID: uID});
     $('.box *').fadeOut(function () {
        $('.box.hide').removeClass('hide');
        $('pre').show();
     });

}
var select = function (id) {
    socket.emit("selection", id);
    feralID = id;
    $('.modal').hide();
}

var showLinkError = function () {
    $('input#link').addClass('error');
}

var hideLinkError = function () {
    $('input#link').removeClass('error');
}

