// review, rating, createdAt, ref to tour, ref to user
const mongoose = require('mongoose');

const reviewSchema = new mongoose.Schema(
    {
        review: {
            type: String,
            required: [true, 'Review can not be empty'],
            trim: true,
        },
        rating: {
            type: Number,
            default: 4.5,
            min: [1, 'The rating must be above 1.0'],
            max: [5, 'The rating must be below 5.0'],
        },
        createdAt: {
            type: Date,
            default: Date.now(),
        },
        tour: {
            type: mongoose.Schema.ObjectId,
            ref: 'Tour',
            required: [true, 'Review must belong to a tour'],
        },
        user: {
            type: mongoose.Schema.ObjectId,
            ref: 'User',
            required: [true, 'Review must belong to a user'],
        },
    },
    {
        toJSON: { virtuals: true },
        toObject: { virtuals: true },
    },
);

reviewSchema.pre(/^find/, function (next) {
    this.populate({
        path: 'user',
    });
    this.populate({
        path: 'tour',
    });

    next();
});

const Review = mongoose.model('Review', reviewSchema);

module.exports = Review;