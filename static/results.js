$(document).ready(function () {
    $(".logo-large").addClass("logo-small").removeClass("logo-large");

    setTimeout(function () {
        $('.flexbox').show();
        $('.flexbox').css("opacity", 1);
        $('h1').css("opacity", 1);
    }, 500);

    $('.tt').popover({"trigger": "hover"})

})