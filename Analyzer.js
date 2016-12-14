
var express = require('express')
var bodyParser = require('body-parser');
var app = express();
var http = require('http').Server(app);
var io = require('socket.io')(http);
var api = require('./apireader');

app.use(express.static('static'));
app.use(express.static('cache'));
app.use(bodyParser.urlencoded({ extended: true }));

app.get('/', function(req, res){
  res.sendfile('templates/index.html');
});

app.post('/validate', function(req, res){
    if (!req.body.code) {
        res.send("ERROR");
        return;
    }

    var code = req.body.code;
    api.getFights(code, function (fights, friendlies) {
        if (fights) {
            if (req.body.fight) {
                var fight = fights[req.body.fight-1];
                if (!fight) {
                    res.send("ERROR");
                    return;
                }
            } else {
                var fight = fights[fights.length-1];
                if (!fight["boss"]) {
                    for (var x=fights.length-1; x>=0; x--) {
                        if (fights[x]["boss"]) {
                            fight = fights[x];
                            break;
                        }
                    }
                }

            }
            res.send(code+"_"+fight["id"]);
            new api.Analyzer(code, fight, friendlies)
        } else {
            res.send("ERROR")
        }
    })
});

http.listen(3000, function(){
  console.log('listening on *:3000');
});

io.on('connection', function(socket){
  console.log('a user connected');
  socket.on('attach', function (data) {
    console.log(data);
    var uID = data["uID"];
    api.socketAttach(uID, socket);
  });
  socket.on('disconnect', function(){
    console.log('user disconnected');
  });
});