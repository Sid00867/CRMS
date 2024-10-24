// server.js
const express = require('express');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
const cors = require('cors');
const http = require('http');


const app = express();
const PORT = process.env.PORT || 5000;
const server = http.createServer(app);
const serverAPIURL = 'http://192.168.236.184:5000'

// Middleware
app.use(bodyParser.json());
app.use(cors({
    origin: '*', // Allow requests from any origin
}));

// MongoDB connection
mongoose.connect('mongodb://localhost:27017/crmsdb', {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
.then(() => console.log('MongoDB connected'))
.catch(err => console.log(err));

// Middleware to parse JSON bodies
app.use(express.json());

// User model
const User = mongoose.model('User', {
  username: String,
  password: String,
  bookedEvents: [{
    roomName: String,
    buildingName: String,
    seatsBooked: Number,
    startTime: Date,
    endTime: Date,
    date: Date
  }]
});

// Room model
const Room = mongoose.model('Room', {
  roomName: String,
  buildingName: String,
  seatingCapacity: Number,
  events: [{
    date: Date,
    eventName: { type: String, optional: true },
    startTime: Date,
    endTime: Date,
    availableSeats: Number
  }]
});

const fs = require('fs');
const path = require('path');

// API to read and process room timetable
app.post('/api/process-timetable', async (req, res) => {
  try {
    // Read the JSON file
    let timetableData;
    try {
      timetableData = JSON.parse(fs.readFileSync(path.join(__dirname, 'room_timetable.json'), 'utf8'));
    } catch (readError) {
      console.error('Error reading timetable file:', readError);
      return res.status(500).json({ message: 'Error reading timetable file' });
    }

    for (const room of timetableData.rooms) {
      try {
        const { buildingName, roomName } = room;

        // Find or create the room in the database
        let dbRoom;
        try {
          dbRoom = await Room.findOne({ buildingName, roomName });
        } catch (findError) {
          console.error('Error finding room:', findError);
          continue; // Skip to next room if there's an error
        }

        if (!dbRoom) {
          // If room doesn't exist, create a new one
          try {
            dbRoom = new Room({
              buildingName,
              roomName,
              seatingCapacity: room.seatingCapacity || 0,
              events: []
            });
          } catch (createError) {
            console.error('Error creating new room:', createError);
            continue; // Skip to next room if there's an error
          }
        } else {
          // Clear existing events for the room
          dbRoom.events = [];
        }

        // Process periods and create events
        for (let i = 0; i < room.periods.length; i++) {
          try {
            const period = room.periods[i];
            if (!period.IsThereClass) {
              // Find the start of the free period
              const startTime = new Date(period.date + 'T' + period.startTime);
              let endTime = new Date(period.date + 'T' + period.endTime);

              // Check if next periods are also free and combine them
              while (i + 1 < room.periods.length && !room.periods[i + 1].IsThereClass) {
                i++;
                endTime = new Date(room.periods[i].date + 'T' + room.periods[i].endTime);
              }

              // Add new event
              dbRoom.events.push({
                date: new Date(period.date),
                startTime: startTime,
                endTime: endTime,
                availableSeats: dbRoom.seatingCapacity
              });
            }
          } catch (periodError) {
            console.error('Error processing period:', periodError);
            continue; // Skip to next period if there's an error
          }
        }

        // Save the updated room
        try {
          await dbRoom.save();
        } catch (saveError) {
          console.error('Error saving room:', saveError);
        }
      } catch (roomError) {
        console.error('Error processing room:', roomError);
      }
    }

    res.status(200).json({ message: 'Timetable processed successfully' });
  } catch (error) {
    console.error('Error processing timetable:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});


// Fetch booked events for a user API

app.post('/api/user-bookings', async (req, res) => {
    const { username } = req.body;

    if (!username) {
        return res.status(400).json({ message: 'Username is required' });
    }

    try {
    // Find the user by username
        const user = await User.findOne({ username });

        if (!user) {
            return res.status (404).json({ message: 'User not found' });
        }

        res.status(200).json({ bookedEvents: user.bookedEvents });
    } catch (error) {
        console.error('Error fetching user bookings:', error);
        res.status (500).json({ message: 'Internal server error' });
    }
});


// Book event API
app.post('/api/book-event', async (req, res) => {
  const { username, event, seatsBooked } = req.body;

  if (!username || !event || !seatsBooked) {
    return res.status(400).json({ message: 'Missing required parameters' });
  }

  try {
    // Parse the event data, handling both regular and MongoDB extended JSON formats
    const eventId = event._id.$oid || event._id;
    const eventDate = new Date(event.date.$date || event.date);
    const eventStartTime = new Date(event.startTime.$date || event.startTime);
    const eventEndTime = new Date(event.endTime.$date || event.endTime);

    // Find the room containing the event
    const room = await Room.findOne({
      'events._id': eventId
    });

    if (!room) {
      return res.status(404).json({ message: 'Room not found for the given event' });
    }

    // Find the specific event in the room's events array
    const roomEvent = room.events.find(e => e._id.toString() === eventId.toString());

    if (!roomEvent) {
      return res.status(404).json({ message: 'Event not found in the room' });
    }

    // Check if there are enough available seats
    if (roomEvent.availableSeats < seatsBooked) {
      return res.status(400).json({ message: 'Not enough available seats' });
    }

    // Update available seats in the room's event
    roomEvent.availableSeats -= seatsBooked;
    await room.save();

    // Find the user and update their bookedEvents
    const user = await User.findOne({ username });

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Add the booked event to the user's bookedEvents array
    user.bookedEvents.push({
      roomName: room.roomName,
      buildingName: room.buildingName,
      seatsBooked: seatsBooked,
      startTime: eventStartTime,
      endTime: eventEndTime,
      date: eventDate
    });

    await user.save();

    res.status(200).json({ message: 'Event booked successfully' });
  } catch (error) {
    console.error('Error booking event:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});


// Search for available rooms API
app.post('/api/search-rooms', async (req, res) => {
    const { buildingName, startTime, endTime } = req.body;
  
    if (!buildingName || !startTime || !endTime) {
      return res.status(400).json({ message: 'Missing required parameters' });
    }
  
    try {
      const searchStartTime = new Date(startTime);
      const searchEndTime = new Date(endTime);
  
      // Find rooms in the specified building
      const rooms = await Room.find({ buildingName });
  
      // Filter rooms and events
      const availableRooms = rooms.reduce((acc, room) => {
        const matchingEvents = room.events.filter(event => 
          event.startTime <= searchStartTime && event.endTime >= searchEndTime
        );
  
        if (matchingEvents.length > 0) {
          acc.push({
            roomId: room._id,
            roomName: room.roomName,
            buildingName: room.buildingName,
            seatingCapacity: room.seatingCapacity,
            events: matchingEvents
          });
        }
  
        return acc;
      }, []);
  
      res.status(200).json(availableRooms);
    } catch (error) {
      console.error('Error searching rooms:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });



// Login route
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;

  try {
    // Find user by username
    const user = await User.findOne({ username });

    if (!user) {
      return res.status(401).json({ message: 'Invalid username or password' });
    }

    // Check password
    if (user.password !== password) {
      return res.status(401).json({ message: 'Invalid username or password' });
    }

    // Login successful
    res.status(200).json({ message: 'Login successful', userId: user._id });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});


server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
