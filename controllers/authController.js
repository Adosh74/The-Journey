const { promisify } = require('util');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const User = require('../models/userModel');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const sendEmail = require('../utils/email');

const signToken = (id) =>
    jwt.sign({ id: id }, process.env.JWT_SECRET, {
        expiresIn: process.env.JWT_EXPIRES_IN,
    });

const createSendToken = (user, statusCode, res) => {
    const token = signToken(user._id);

    const cookieOption = {
        expires: new Date(
            Date.now() +
                process.env.JWT_COOKIE_EXPIRES_IN * 24 * 60 * 60 * 1000,
        ),
        httpOnly: true,
    };

    if (process.env.NODE_ENV === 'production') cookieOption.secure = true;

    res.cookie('JWT', token, cookieOption);

    user.password = undefined;
    res.status(statusCode).json({
        status: 'success',
        token,
        data: {
            user,
        },
    });
};

exports.logout = (req, res) => {
    res.cookie('JWT', 'loggedout', {
        expires: new Date(Date.now() + 10 * 1000),
        httpOnly: true,
    });

    res.status(200).json({ status: 'success' });
};

exports.signup = catchAsync(async (req, res, next) => {
    const newUser = await User.create({
        name: req.body.name,
        email: req.body.email,
        photo: req.body.photo,
        password: req.body.password,
        passwordConfirm: req.body.passwordConfirm,
        role: req.body.role,
    });

    createSendToken(newUser, 201, res);
});

exports.login = catchAsync(async (req, res, next) => {
    const { email, password } = req.body;

    // Check if user send email and password
    if (!email || !password) {
        return next(new AppError('Please provide email and password', 400));
    }

    // Check if user exist and password is correct
    const user = await User.findOne({
        email: email,
    }).select('+password');

    if (!user || !(await user.correctPassword(password, user.password))) {
        return next(new AppError('Incorrect email or password', 401));
    }

    createSendToken(user, 200, res);
});

exports.protect = catchAsync(async (req, res, next) => {
    // +[1] get the token and check if it's there
    let token;
    if (
        req.headers.authorization &&
        req.headers.authorization.startsWith('Bearer')
    ) {
        token = req.headers.authorization.split(' ')[1];
    } else if (req.cookies.JWT) {
        token = req.cookies.JWT;
    }

    if (!token) {
        return next(
            new AppError('You are not logged in! Please log in to get access'),
            401,
        );
    }

    // +[2] Verification token
    const decoded = await promisify(jwt.verify)(token, process.env.JWT_SECRET);

    // +[3] Check if user still exist
    const freshUser = await User.findById(decoded.id);
    if (!freshUser) {
        return next(
            new AppError(
                'The user belonging to this token does no longer exist',
                401,
            ),
        );
    }
    // +[4] Check if user changed password after the token was issued
    if (freshUser.passwordChangedAfter(decoded.iat)) {
        return next(
            new AppError(
                'User recently changed password! Please login again',
                401,
            ),
        );
    }

    req.user = freshUser;
    next();
});

exports.isLoggedIn = catchAsync(async (req, res, next) => {
    // +[1] get the token and check if it's there
    if (req.cookies.JWT) {
        // +[2] Verification token
        try {
            const decoded = await promisify(jwt.verify)(
                req.cookies.JWT,
                process.env.JWT_SECRET,
            );

            // +[3] Check if user still exist
            const freshUser = await User.findById(decoded.id);
            if (!freshUser) {
                return next();
            }
            // +[4] Check if user changed password after the token was issued
            if (freshUser.passwordChangedAfter(decoded.iat)) {
                return next();
            }

            res.locals.user = freshUser;
        } catch (error) {
            return next();
        }
        return next();
    }
    next();
});

exports.restrictTo =
    (...roles) =>
    (req, res, next) => {
        if (!roles.includes(req.user.role)) {
            return next(
                new AppError(
                    'You do not have permission to perform this action',
                ),
            );
        }

        next();
    };

exports.forgotPassword = catchAsync(async (req, res, next) => {
    // +[1] get email and check if user exists
    const user = await User.findOne({ email: req.body.email });
    if (!user) {
        return next(
            new AppError('This is no user with this email address', 404),
        );
    }

    // +[2] generate the random reset token
    const resetToken = user.createPasswordResetToken();
    await user.save({ validateBeforeSave: false });

    // +[3] send it to user's email
    const resetURL = `${req.protocol}://${req.get(
        'host',
    )}/api/v1/users/resetPassword/${resetToken}`;

    const message = `Forgot your password? Submit a PATCH request with your new password and passwordConfirm to: ${resetURL}.\nIf you didn't forget your password, please ignore this email!`;

    try {
        await sendEmail({
            email: user.email,
            subject: 'Your password reset token (valid for 10 min)',
            message: message,
        });

        res.status(200).json({
            status: 'success',
            message: 'token sent to email!',
        });
    } catch (error) {
        user.passwordResetToken = undefined;
        user.passwordResetExpires = undefined;
        await user.save({ validateBeforeSave: false });
        return next(
            new AppError(
                'There was an error sending the email. Try again later!',
                500,
            ),
        );
    }
});

exports.resetPassword = catchAsync(async (req, res, next) => {
    // +[1] Get user based on the token
    const hashedToken = crypto
        .createHash('sha256')
        .update(req.params.token)
        .digest('hex');

    const user = await User.findOne({
        passwordResetToken: hashedToken,
        passwordResetExpires: { $gt: Date.now() },
    });

    // +[2] Check the token not expired and there is user and set new password
    if (!user) {
        return next(new AppError('Token has invalid or expired', 400));
    }

    user.password = req.body.password;
    user.passwordConfirm = req.body.passwordConfirm;
    user.passwordResetToken = undefined;
    user.passwordResetExpires = undefined;
    await user.save();

    // +[3] Update changedPasswordAt property for the user
    // user.passwordChangedAt = Date.now();

    // +[4] Log the user in, send JWT token
    createSendToken(user, 200, res);
});

exports.updatePassword = catchAsync(async (req, res, next) => {
    // +[1] Get user from collection
    const user = await User.findById(req.user.id).select('+password');

    // +[2] Check if POSTed current password is correct
    if (
        !(await user.correctPassword(req.body.passwordCurrent, user.password))
    ) {
        return next(new AppError('Your current password is incorrect', 401));
    }

    // +[3] If so, update password
    user.password = req.body.password;
    user.passwordConfirm = req.body.passwordConfirm;
    await user.save();

    // +[4] Log user in, send JWT token
    createSendToken(user, 200, res);
});
