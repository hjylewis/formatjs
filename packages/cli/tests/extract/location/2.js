// @intl foo:bar baz:1
import React, {Component} from 'react';
import {defineMessages, FormattedMessage} from 'react-intl';

const msgs = defineMessages({
  kittens: {
    id: 'app.home.kittens',
    description: 'Counts kittens',
    defaultMessage: '{count, plural, =0 {😭} one {# kitten} other {# kittens}}',
  },

  noId: {
    description: 'no ID',
    defaultMessage: 'No ID',
  },
  duplicateAsNoId: {
    description: 'no ID',
    defaultMessage: 'No ID',
  },
});

export default class Foo extends Component {
  render() {
    return (
      <div>
        <p>
          <FormattedMessage {...msgs.kittens} />
          <FormattedMessage
            id="inline-msg"
            defaultMessage="inline message"
            description="inline description"
          />
        </p>
      </div>
    );
  }
}
