/* 
  Interactions with the WarcraftLogs API
*/

var http = require('https');

var host = "www.warcraftlogs.com";
var base = "/v1/report";
var apiKey = ""; // Get yours on https://www.warcraftlogs.com/accounts/changeuser

var difficulties = ["Unknown", "LFR", "Flex", "Normal", "Heroic", "Mythic"];


var nunjucks = require('nunjucks');
var fs = require('fs');
nunjucks.configure('templates', { autoescape: false });


// Simplifies API requests
var apiRequest = function(url, args, callback) {
    var options = {
        host: host,
        path: base+url+"?api_key="+apiKey+"&"+args,
        port: 443,
        method: 'GET'
    };

    console.log("API Request:", "https://"+options["host"]+options["path"]);

    var request = http.request(options, function(response) {
        var result = "";
        response.on('data', function (chunk) {
            result+=chunk;
        });

        response.on('end', function () {
            result = JSON.parse(result);
            if (result) {
                callback(result);
            } else {
                callback(null);
            }

        })
    }).end();
} 


function getFights(code, callback) {
    apiRequest("/fights/"+code, "", function (result) {
        var fights = result["fights"];
        callback(fights, result["friendlies"]);
    });
}


var analyzers = {};

var Analyzer = function(code, fight, friendlies) {
    // Unique identifier for a fight
    var uID = code+"_"+fight["id"]

    // Little function to check if the client gave us a valid fight ID
    var validate = (uid) => (/[A-z0-9_]*/.exec(uid)[0] == uid)

    // Hold all websockets listening on this analyzer
    var sockets = [];

    // Don't do the same analysis twice
    if (analyzers[uID] != undefined) return analyzers[uID];

    analyzers[uID] = this;


    var step = 0;
    var participants = {};
    var ferals = [];
    var duration = fight["end_time"]-fight["start_time"];
    var feralID = 0;
    var selected = false;
    var current;

    var logStr = "Starting Log Clawnalysis"

    // This is called when a new websocket asks for this analyzer
    this.socketConnect = function (socket) {
        sockets.push(socket);
        if (logStr.startsWith("Multiple Ferals")) {
            var list = [];
            for (var x=0; x<ferals.length; x++) {
                list.push(ferals[x].name);
            }
            console.log("Asking for selection!");
            socket.emit("selection", list);
            socket.on("selection", onSelection);
        }
        socket.send(logStr);
        console.log("Sending Log...")
    }

    var log = function (text) {
        logStr = text+"\n"+logStr;
        for (var x=0; x<sockets.length; x++) {
            sockets[x].send(text);
        }
        console.log(text);
    }


    // If the fight was logged without advanced combat logging enabled, manually set it to Unknown
    if (difficulties[fight["difficulty"]] === undefined) fight["difficulty"] = 0;

    log("Analzing fight versus "+fight["name"]+" ("+difficulties[fight["difficulty"]]+" difficulty)");

    // Go through all the steps
    var next = function () {
        var steps = [getParticipants, getDebuffs, getBuffs, getBloodtalonsBenefits, getTigersfuryBenefits, getSavageroarBenefits, getCooldownUsage];
        try {
            steps[step++]();
        } catch (e) {
            console.log(e);
        } 
    }

    // After everything's done, render the result, write to html file and clean up
    var finish = function () {
        log("Rendering result page");

        var link = "https://www.warcraftlogs.com/reports/"+code+"#fight="+fight["id"]+"&type=damage-done";
        var result = nunjucks.render('result.html', { feral: current, duration: duration, boss: fight["name"]+" ("+difficulties[fight["difficulty"]]+" difficulty)", link: link });

        fs.writeFile('./cache/'+uID+'_'+feralID+'.html', result, (err) => {
          if (err) throw err;
          log('DONE!');
        });

        var meta = [];
        for (var x=0; x<ferals.length; x++) {
            var f = ferals[x].name;
            meta.push(f);
        }

        fs.writeFile('./cache/'+uID+'.json', JSON.stringify(meta), (err) => {
            if (err) throw err;
        })

        logStr = "";
        analyzers[uID] = undefined;
    }

    var getParticipants = function() {
        log("Reading list of participants");
        ferals = [];
        
        for (var x=0; x<friendlies.length;x++) {
            participants[friendlies[x]["id"]] = friendlies[x]["name"];
        }

        // Try to read the "combatantinfo" events that should be at the beginning of the log
        apiRequest("/events/"+code, "start="+fight["start_time"]+"&end="+fight["start_time"]+1000, function (result) {
            var events = result.events;
            for (var x=0; x<events.length; x++) {
                var ev = events[x];
                if (ev.type = "combatantinfo") {
                    if (ev.specID == 103) {
                        log("Found Feral Druid "+participants[ev.sourceID]);
                        ferals.push( {
                                                name: participants[ev.sourceID],
                                                info: ev
                                              })
                    }
                }
            };

            if (ferals.length == 0) {
                log("No Feral druid found by spec information, trying to find one by Rake casts")

                // Without advanced combat logging, we won't have combatantinfo events, so wel'll have to guess by casts
                apiRequest("/tables/casts/"+code, "start="+fight["start_time"]+"&end="+fight["end_time"]+"&filter=ability.id+IN+(1822)", function (result) {
                    var entries = result.entries;
                    for (var x=0; x<entries.length; x++) {
                        log("Found Rake cast by "+entries[x].name+" assuming Feral spec");
                        ferals.push({
                            name: entries[x].name,
                            info: {"sourceID": entries[x]["id"]}});
                    }

                    if (ferals.length == 0) { // No ferals
                        log("No Feral Druids in this fight.");
                        return;
                    } else if (ferals.length == 1) { // One feral
                        current = ferals[0];
                        next();
                    
                    } else if (ferals.length > 1) { // Multiple ferals, ask for selection
                    
                        var list = [];
                        for (var x=0; x<ferals.length; x++) {
                            list.push(ferals[x].name);
                        }
                        for (var x=0; x<sockets.length; x++) {
                            sockets[x].emit("selection", list);
                            log("Multiple Ferals found, waiting for selection")
                            sockets[x].on("selection", onSelection);

                            // Timeout after 60 seconds if the user doesn't select a player
                            setTimeout(function () {analyzers[uID] == undefined}, 60000);
                        }
                    }
                });

            } else if (ferals.length == 1 || selected) { // One feral (or the user manually selected one)
                current = ferals[feralID];
                next();
            } else if (ferals.length > 1) { // Multiple Ferals, ask for selection
                var list = [];
                for (var x=0; x<ferals.length; x++) {
                    list.push(ferals[x].name);
                }
                for (var x=0; x<sockets.length; x++) {
                    sockets[x].emit("selection", list);
                    log("Multiple Ferals found, waiting for selection")
                    sockets[x].on("selection", onSelection);

                    // Timeout after 60 seconds if the user doesn't select a player
                    setTimeout(function () {analyzers[uID] == undefined}, 60000);
                }
            }
        });
    }


    // Called when the user selects one of multiple ferals in a fight
    var onSelection = function (choice) {
        current = ferals[choice];
        feralID = choice;
        selected = true;
        try {
            var stats = fs.statSync("./cache/"+uID+"_"+feralID+".html")
            if (stats.isFile) {
                log("DONE!\nResult "+uID+"_"+feralID+" is already cached!");
                logStr = "";
                analyzers[uID] = undefined;
                return;
            }
        } catch (e) {
            console.log("No html cache", e);
        }

        next();
    }

    var getDebuffs = function () {
        log("Querying Debuff Uptimes for "+ current.name);

        // Rip, Rake, Moonfire
        apiRequest("/tables/debuffs/"+code, "start="+fight["start_time"]+"&end="+fight["end_time"]+"&sourceid="+current["info"]["sourceID"]+"&by=target&translate=true", function (result) {
            var totalTime = result["totalTime"];
            current.moonfire = {"totalUptime": 0, "pctUptime": 0};
            for (var x=0; x<result["auras"].length;x++) {
                var aura = result["auras"][x];
                console.log(aura.name, aura.totalUptime, 100*aura.totalUptime/totalTime,"%");
                if (aura["name"] == "Rip") {
                    current.rip = {"totalUptime": aura.totalUptime, "pctUptime": 100*aura.totalUptime/totalTime}
                } else if (aura["name"] == "Rake") {
                    current.rake = {"totalUptime": aura.totalUptime, "pctUptime": 100*aura.totalUptime/totalTime}
                } else if (aura["name"] == "Moonfire") {
                    current.moonfire = {"totalUptime": aura.totalUptime, "pctUptime": 100*aura.totalUptime/totalTime}
                } else if (aura["name"] == "Ashamane's Rip") {
                    current.asharip = {"totalUptime": aura.totalUptime, "pctUptime": 100*aura.totalUptime/totalTime}
                }
            }
            next();
        });
        
    }

    var getBuffs = function () {
        log("Querying Buff Uptimes for "+ current.name);

        apiRequest("/tables/buffs/"+code, "start="+fight["start_time"]+"&end="+fight["end_time"]+"&sourceid="+current["info"]["sourceID"]+"&by=target&translate=true", function (result) {
            var totalTime = result["totalTime"];
            for (var x=0; x<result["auras"].length;x++) {
                var aura = result["auras"][x];
                console.log(aura.name, aura.totalUptime, 100*aura.totalUptime/totalTime,"%");
                if (aura["name"] == "Defiled Augmentation") {
                    current.augmentrune = {"totalUptime": aura.totalUptime, "pctUptime": 100*aura.totalUptime/totalTime}
                } else if (aura["name"] == "Well Fed") {
                    current.bufffood = {"totalUptime": aura.totalUptime, "pctUptime": 100*aura.totalUptime/totalTime}
                } else if (aura["name"] == "Savage Roar") {
                    current.savageroar = {"totalUptime": aura.totalUptime, "pctUptime": 100*aura.totalUptime/totalTime}
                } else if (aura["name"] == "Flask of the Seventh Demon") {
                    current.flask = {"totalUptime": aura.totalUptime, "pctUptime": 100*aura.totalUptime/totalTime}
                } else if (aura["name"] == "Potion of the Old War") {
                    current.oldwar = aura.totalUses;
                } else if (aura["name"] == "Potion of Prolonged Power") {
                    current.prolongedpower = aura.totalUses;
                }
            }
            next();
        });
        
    }

    var getBloodtalonsBenefits = function () {
        log("Analyzing Bloodtalons benefits for "+ current.name);

        current.bloodtalons = {};
        current["bloodtalons"]["nobenefit"] = {"Ashamane's Frenzy": 0, "Rake": 0, "Rip": 0, "Ferocious Bite": 0, "Shred": 0};
        current["bloodtalons"]["benefit"] = {"Ashamane's Frenzy": 0, "Rake": 0, "Rip": 0,"Ferocious Bite": 0, "Shred": 0};
        
        // Using warcraftlogs filter expression to find buffed casts 
        apiRequest("/tables/casts/"+code, "start="+fight["start_time"]+"&end="+fight["end_time"]+"&sourceid="+current["info"]["sourceID"]+"&translate=true&filter=NOT+IN+RANGE+%0AFROM+type+%3D+%22applybuff%22+AND+ability.id+%3D+145152+TO+type+%3D+%22removebuff%22+AND+ability.id+%3D+145152+GROUP+BY+source+END%0AAND+ability.id+IN+(22568,155625,1822,231052,+1079,+231056,+210722,5221)", function (result) {
            var entries = result["entries"];
            for (var x=0; x<entries.length; x++) {
                var entry = entries[x];
                current["bloodtalons"]["nobenefit"][entry["name"]] = entry["total"];
            }
        

            apiRequest("/tables/casts/"+code, "start="+fight["start_time"]+"&end="+fight["end_time"]+"&sourceid="+current["info"]["sourceID"]+"&translate=true&filter=IN+RANGE+%0AFROM+type+%3D+%22applybuff%22+AND+ability.id+%3D+145152+TO+type+%3D+%22removebuff%22+AND+ability.id+%3D+145152+GROUP+BY+source+END%0AAND+ability.id+IN+(22568,155625,1822,231052,+1079,+231056,+210722,5221)", function (result) {
                var entries = result["entries"];
                for (var x=0; x<entries.length; x++) {
                    var entry = entries[x];
                    current["bloodtalons"]["benefit"][entry["name"]] = entry["total"];
                }
                apiRequest("/events/"+code, "start="+fight["start_time"]+"&end="+fight["end_time"]+"&sourceid="+current["info"]["sourceID"]+"&translate=true&filter=type=\"cast\"+AND+ability.id+IN+(22568,1822,231052,+1079,+231056,+210722,5221)", function (result) {
                    var entries = result["events"];
                    var x=0;
                    for (var x=0; x<2; x++) {
                        var entry = entries[x];
                        current["bloodtalons"]["benefit"][entry["ability"]["name"]]++;
                        current["bloodtalons"]["nobenefit"][entry["ability"]["name"]]--;
                    }

                    next();
                });
            });
        });
    }

    var getTigersfuryBenefits = function () {
        log("Analyzing Tiger's Fury benefits for "+ current.name);

        current.tf = {};
        current["tf"]["nobenefit"] = {"Ashamane's Frenzy": 0, "Rake": 0, "Rip": 0, "Shred": 0, "Ferocious Bite": 0, "Moonfire": 0};
        current["tf"]["benefit"] = {"Ashamane's Frenzy": 0, "Rake": 0, "Rip": 0, "Shred": 0, "Ferocious Bite": 0, "Moonfire": 0};
        
        // Using warcraftlogs filter expression to find buffed casts 
        apiRequest("/tables/casts/"+code, "start="+fight["start_time"]+"&end="+fight["end_time"]+"&sourceid="+current["info"]["sourceID"]+"&translate=true&filter=NOT+IN+RANGE+%0AFROM+type+%3D+%22applybuff%22+AND+ability.id+%3D+5217+TO+type+%3D+%22removebuff%22+AND+ability.id+%3D+5217+GROUP+BY+source+END%0AAND+ability.id+IN+(22568,155625,1822,231052,+1079,+231056,+210722,5221)", function (result) {
            var entries = result["entries"];
            for (var x=0; x<entries.length; x++) {
                var entry = entries[x];
                current["tf"]["nobenefit"][entry["name"]] = entry["total"];
            }
        

            apiRequest("/tables/casts/"+code, "start="+fight["start_time"]+"&end="+fight["end_time"]+"&sourceid="+current["info"]["sourceID"]+"&translate=true&filter=IN+RANGE+%0AFROM+type+%3D+%22applybuff%22+AND+ability.id+%3D+5217+TO+type+%3D+%22removebuff%22+AND+ability.id+%3D+5217+GROUP+BY+source+END%0AAND+ability.id+IN+(22568,155625,1822,231052,+1079,+231056,+210722,5221)", function (result) {
                var entries = result["entries"];
                for (var x=0; x<entries.length; x++) {
                    var entry = entries[x];
                    current["tf"]["benefit"][entry["name"]] = entry["total"];
                }            
                
                next();
            });
        });
    }

    var getSavageroarBenefits = function () {
        log("Analyzing Savage Roar benefits for "+ current.name);

        current.sr = {};
        current["sr"]["nobenefit"] = {"Ashamane's Frenzy": 0, "Rake": 0, "Rip": 0, "Shred": 0, "Ferocious Bite": 0, "Moonfire": 0};
        current["sr"]["benefit"] = {"Ashamane's Frenzy": 0, "Rake": 0, "Rip": 0, "Shred": 0, "Ferocious Bite": 0, "Moonfire": 0};

        apiRequest("/tables/casts/"+code, "start="+fight["start_time"]+"&end="+fight["end_time"]+"&sourceid="+current["info"]["sourceID"]+"&translate=true&filter=NOT+IN+RANGE+%0AFROM+type+%3D+%22applybuff%22+AND+ability.id+%3D+52610+TO+type+%3D+%22removebuff%22+AND+ability.id+%3D+52610+GROUP+BY+source+END%0AAND+ability.id+IN+(22568,155625,1822,231052,+1079,+231056,+210722,5221)", function (result) {
            var entries = result["entries"];
            for (var x=0; x<entries.length; x++) {
                var entry = entries[x];
                current["sr"]["nobenefit"][entry["name"]] = entry["total"];
            }

            apiRequest("/tables/casts/"+code, "start="+fight["start_time"]+"&end="+fight["end_time"]+"&sourceid="+current["info"]["sourceID"]+"&translate=true&filter=IN+RANGE+%0AFROM+type+%3D+%22applybuff%22+AND+ability.id+%3D+52610+TO+type+%3D+%22removebuff%22+AND+ability.id+%3D+52610+GROUP+BY+source+END%0AAND+ability.id+IN+(22568,155625,1822,231052,+1079,+231056,+210722,5221)", function (result) {
                var entries = result["entries"];
                for (var x=0; x<entries.length; x++) {
                    var entry = entries[x];
                    current["sr"]["benefit"][entry["name"]] = entry["total"];
                }
                
                next();
            });
        });
    }

    var getCooldownUsage = function () {

        // Cooldown duration in miliseconds
        var cds = {
            5217: 30000, // Tiger's Fury
            106951: 180000, // Berserk
            26297: 180000, // Berserking (Troll)
            58984: 120000, // Shadowmeld (Night Elf)
            210722: 75000, // Ashamane's Frenzy
            188028: 999999000, // Potion of the Old War
            229206: 999999000 // Potion of Prolonged Power
        }
        current.cooldowns = {}
        for (cd in cds) current.cooldowns[cd] = [0,Math.ceil(duration/cds[cd])];
        log("Analyzing Cooldown Usage for "+ current.name);
        apiRequest("/tables/casts/"+code, "start="+fight["start_time"]+"&end="+fight["end_time"]+"&sourceid="+current["info"]["sourceID"]+"&translate=true&filter=ability.id+IN+(26297,5217,+106951,+58984,+210722,+188028,+229206)", function (result) {
            var entries = result["entries"];
            for (var x=0; x<entries.length; x++) {
                var entry = entries[x];
                current["cooldowns"][entry["guid"]][0] = entry["total"];
            }

            finish();
        })    


    }

    if (validate(uID)) {

        // Do we already have a cached version of this fight?
        try {
            var stats = fs.statSync("./cache/"+uID+".json")
            if (stats.isFile) {
                console.log("Found meta cache");
                fs.readFile("./cache/"+uID+".json", function (err, data) {
                    console.log(data);
                    if (err) throw err;
                    var list = JSON.parse(data);
                    console.log(list);
                    if (list.length > 1) {
                        log("Multiple Ferals found, waiting for selection")
                        ferals = list.map((x) => {return {"name": x}})
                        for (var x=0; x<sockets.length; x++) {
                            sockets[x].emit("selection", list);
                            sockets[x].on("selection", onSelection);
                        }

                        setTimeout(function () {analyzers[uID] == undefined}, 60000);
                    } else {
                        log("One feral in this fight, skipping selection");
                        onSelection(0);
                    }
                });

                return;
            }
        } catch (e) {
            console.log("No meta file found in cache", e);
            next();
        }
    }
}


// Match a new websocket to an analyzer, or send it directly to cached file if that exists 
var socketAttach = function(uid, socket) {
    var validate = (id) => (/[A-z0-9_]*/.exec(id)[0] == id)

    if (analyzers[uid] != undefined) {
        analyzers[uid].socketConnect(socket);
    } else if (validate(uid)) {
        var stats = fs.statSync("./cache/"+uid+"_"+0+".html")
        if (stats.isFile) socket.send("DONE!\nResult "+uid+"_"+0+" is already cached!");
        console.log("Warning", "Trying to attach socket to invalid uID", uid, analyzers)
    }
}


exports.getFights = getFights;
exports.Analyzer = Analyzer;
exports.socketAttach = socketAttach;