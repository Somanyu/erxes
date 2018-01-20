/* eslint-env jest */
/* eslint-disable no-underscore-dangle */

import { connect, disconnect } from '../db/connection';
import {
  Customers,
  Users,
  ActivityLogs,
  ConversationMessages,
  Conversations,
  EngageMessages,
  InternalNotes,
} from '../db/models';
import { userFactory, customerFactory } from '../db/factories';
import customerMutations from '../data/resolvers/mutations/customers';

beforeAll(() => connect());

afterAll(() => disconnect());

describe('Customers mutations', () => {
  let _user;
  let _customer;

  beforeEach(async () => {
    // Creating test data
    _user = await userFactory();
    _customer = await customerFactory();
  });

  afterEach(async () => {
    // Clearing test data
    await Users.remove({});
    await Customers.remove({});
  });

  test('Check login required', async () => {
    expect.assertions(4);

    const check = async fn => {
      try {
        await fn({}, {}, {}, {}, {}, {});
      } catch (e) {
        expect(e.message).toEqual('Login required');
      }
    };

    // add
    check(customerMutations.customersAdd);

    // edit
    check(customerMutations.customersEdit);

    // add company
    check(customerMutations.customersAddCompany);

    // edot customer companies
    check(customerMutations.customersEditCompanies);

    // merge customers
    check(customerMutations.customerMerge);

    // remove customers
    check(customerMutations.customersRemove);
  });

  test('Create customer', async () => {
    Customers.createCustomer = jest.fn(() => {
      return {
        name: 'name',
        _id: 'fakeCustomerId',
      };
    });

    const doc = { name: 'name', email: 'dombo@yahoo.com' };

    await customerMutations.customersAdd({}, doc, { user: _user });

    expect(Customers.createCustomer).toBeCalledWith(doc);
  });

  test('Edit customer valid', async () => {
    const doc = {
      name: 'Dombo',
      email: 'dombo@yahoo.com',
      phone: '242442200',
    };

    Customers.updateCustomer = jest.fn();

    await customerMutations.customersEdit({}, { _id: _customer._id, ...doc }, { user: _user });

    expect(Customers.updateCustomer).toBeCalledWith(_customer._id, doc);
  });

  test('Add company', async () => {
    Customers.addCompany = jest.fn(() => {
      return {
        name: 'name',
        _id: 'fakeCustomerId',
      };
    });

    const doc = { name: 'name', website: 'http://company.com' };

    await customerMutations.customersAddCompany({}, doc, { user: _user });

    expect(Customers.addCompany).toBeCalledWith(doc);
  });

  test('Update Customer Companies', async () => {
    Customers.updateCompanies = jest.fn();

    const companyIds = ['companyid1', 'companyid2', 'companyid3'];

    await customerMutations.customersEditCompanies(
      {},
      { _id: _customer._id, companyIds },
      { user: _user },
    );

    expect(Customers.updateCompanies).toBeCalledWith(_customer._id, companyIds);
  });

  test('Merging customers', async () => {
    const customerIds = ['customerid1', 'customerid2'];
    const newCustomer = await customerFactory({});

    const aLog = (ActivityLogs.changeCustomer = jest.fn());
    const iNote = (InternalNotes.changeCustomer = jest.fn());
    const cMessages = (ConversationMessages.changeCustomer = jest.fn());
    const conversations = (Conversations.changeCustomer = jest.fn());
    const eMessages = (EngageMessages.changeCustomer = jest.fn());
    const eRMessages = (EngageMessages.changeCustomer = jest.fn());

    aLog(newCustomer._id, customerIds);
    iNote(newCustomer._id, customerIds);
    cMessages(newCustomer._id, customerIds);
    conversations(newCustomer._id, customerIds);
    eMessages(newCustomer._id, customerIds);
    eRMessages(newCustomer._id, customerIds);

    await customerMutations.customersMerge({}, { customerIds, newCustomer }, { user: _user });

    expect(aLog).toBeCalledWith(newCustomer._id, customerIds);
    expect(iNote).toBeCalledWith(newCustomer._id, customerIds);
    expect(cMessages).toBeCalledWith(newCustomer._id, customerIds);
    expect(conversations).toBeCalledWith(newCustomer._id, customerIds);
    expect(eMessages).toBeCalledWith(newCustomer._id, customerIds);
    expect(eRMessages).toBeCalledWith(newCustomer._id, customerIds);
  });

  test('Customer remove', async () => {
    Customers.removeCustomer = jest.fn();
    const newCustomer = await customerFactory({});

    await customerMutations.customersRemove(
      {},
      { customerIds: [newCustomer._id] },
      { user: _user },
    );

    expect(Customers.removeCustomer).toBeCalledWith(newCustomer._id);
  });
});
